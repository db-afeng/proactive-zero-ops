from __future__ import annotations

import hashlib
import subprocess
from collections.abc import Mapping
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

from lineage_guard.bundle import (
    BundleChangeSet,
    BundleResource,
    BundleSnapshot,
    GitRevisionTree,
    ResourceChange,
    compare_bundle_snapshots,
    discover_bundle,
)
from lineage_guard.models import EvidenceOrigin, LineageEdge
from lineage_guard.sql_analysis import (
    InputSource,
    SqlDocumentAnalysis,
    SqlDocumentChange,
    compare_sql_documents,
    parse_sql_document,
)

_CONSUMER_RESOURCE_TYPES = frozenset({"dashboards", "genie_spaces"})
_APP_SCOPE_ADDITIONS = frozenset({"genie", "workspace.workspace:read"})
_APP_LINEAGE_BINDING = {
    "name": "table-lineage",
    "uc_securable": {
        "securable_full_name": "system.access.table_lineage",
        "securable_type": "TABLE",
        "permission": "SELECT",
    },
}


class GitError(RuntimeError):
    pass


@dataclass(frozen=True)
class AnalysisIssue:
    revision: str
    source: str
    code: str
    message: str
    path: str | None = None


@dataclass(frozen=True)
class DiscoveredSqlDocument:
    resource_type: str
    resource_key: str
    path: str
    analysis: SqlDocumentAnalysis

    @property
    def resource_identity(self) -> str:
        return f"{self.resource_type}.{self.resource_key}"

    @property
    def key(self) -> tuple[str, str]:
        return self.resource_identity, self.path


@dataclass(frozen=True)
class RevisionAnalysis:
    bundle: BundleSnapshot
    documents: tuple[DiscoveredSqlDocument, ...]
    issues: tuple[AnalysisIssue, ...]

    @property
    def complete(self) -> bool:
        return (
            self.bundle.complete
            and not self.issues
            and all(document.analysis.complete for document in self.documents)
        )

    @property
    def document_map(self) -> dict[tuple[str, str], DiscoveredSqlDocument]:
        return {document.key: document for document in self.documents}


@dataclass(frozen=True)
class SqlChange:
    resource_identity: str
    change: SqlDocumentChange

    @property
    def before_path(self) -> str | None:
        return self.change.base.path if self.change.base else None

    @property
    def after_path(self) -> str | None:
        return self.change.proposed.path if self.change.proposed else None


@dataclass(frozen=True)
class ChangeSet:
    base_sha: str
    head_sha: str
    target: str | None
    changed_files: list[str]
    base: RevisionAnalysis
    proposed: RevisionAnalysis
    bundle_changes: BundleChangeSet
    sql_changes: tuple[SqlChange, ...]
    issues: tuple[AnalysisIssue, ...]
    affected_datasets: frozenset[str]
    proposed_code_edges: tuple[LineageEdge, ...]

    @property
    def complete(self) -> bool:
        return self.base.complete and self.proposed.complete and not self.issues

    @property
    def formatting_only_files(self) -> tuple[str, ...]:
        return tuple(
            change.after_path or change.before_path or ""
            for change in self.sql_changes
            if change.change.formatting_only
        )

    @property
    def meaningful_sql_changes(self) -> tuple[SqlChange, ...]:
        return tuple(
            change
            for change in self.sql_changes
            if change.change.kind != "unchanged" and not change.change.formatting_only
        )

    @property
    def has_relevant_changes(self) -> bool:
        bundle = self.bundle_changes
        formatting_only = set(self.formatting_only_files)
        relevant_source_changes = [
            change
            for change in bundle.source_changes
            if change.kind != "modified"
            or (change.after_path or change.before_path or "") not in formatting_only
        ]
        relevant_resource_changes = [
            change
            for change in bundle.resource_changes
            if not _is_non_dataset_resource_change(change)
        ]
        return bool(
            self.meaningful_sql_changes
            or bundle.configuration_changes
            or bundle.variable_changes
            or relevant_resource_changes
            or relevant_source_changes
        )

    def restricted_evidence(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "base_sha": self.base_sha,
            "head_sha": self.head_sha,
            "changed_files": self.changed_files,
            "bundle_changes": asdict(self.bundle_changes),
            "sql_changes": [asdict(change) for change in self.sql_changes],
            "discovery_issues": [asdict(issue) for issue in self.issues],
            "affected_datasets": sorted(self.affected_datasets),
            "proposed_code_dependencies": [
                edge.model_dump(mode="json") for edge in self.proposed_code_edges
            ],
        }


def _is_non_dataset_resource_change(change: ResourceChange) -> bool:
    """Exempt only consumer resources and the app's read-only lineage access delta."""
    resources = tuple(resource for resource in (change.before, change.after) if resource)
    if resources and all(
        resource.resource_type in _CONSUMER_RESOURCE_TYPES for resource in resources
    ):
        return True
    return _is_read_only_app_change(change)


def _is_read_only_app_change(change: ResourceChange) -> bool:
    if (
        change.kind != "modified"
        or change.before is None
        or change.after is None
        or change.before.identity != change.after.identity
        or change.before.resource_type != "apps"
        or {field.field for field in change.fields} - {"user_api_scopes", "resources"}
    ):
        return False
    before = dict(change.before.config)
    after = dict(change.after.config)
    old_scopes = before.pop("user_api_scopes", [])
    new_scopes = after.pop("user_api_scopes", [])
    old_bindings = before.pop("resources", [])
    new_bindings = after.pop("resources", [])
    if before != after:
        return False
    if not _is_allowed_scope_addition(old_scopes, new_scopes):
        return False
    if not isinstance(old_bindings, list) or not isinstance(new_bindings, list):
        return False
    if new_bindings == old_bindings:
        return True
    if _APP_LINEAGE_BINDING in old_bindings or len(new_bindings) != len(old_bindings) + 1:
        return False
    return any(
        binding == _APP_LINEAGE_BINDING
        and new_bindings[:index] + new_bindings[index + 1 :] == old_bindings
        for index, binding in enumerate(new_bindings)
    )


def _is_allowed_scope_addition(before: Any, after: Any) -> bool:
    if not isinstance(before, list) or not isinstance(after, list):
        return False
    if not all(isinstance(scope, str) for scope in (*before, *after)):
        return False
    old = set(before)
    new = set(after)
    return (
        len(old) == len(before)
        and len(new) == len(after)
        and old <= new
        and new - old <= _APP_SCOPE_ADDITIONS
    )


def _git(repo: Path, args: list[str], *, allow_failure: bool = False) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode and not allow_failure:
        raise GitError(completed.stderr.strip() or f"git command failed: {' '.join(args)}")
    return completed.stdout


def resolve_commit(repo: Path, ref: str) -> str:
    return _git(repo, ["rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"]).strip()


def read_file_at_commit(repo: Path, sha: str, path: str) -> str:
    return _git(repo, ["show", f"{sha}:{path}"], allow_failure=True)


def _changed_paths(repo: Path, base_sha: str, head_sha: str) -> tuple[list[str], dict[str, str]]:
    output = _git(
        repo,
        [
            "diff",
            "--name-status",
            "--find-renames=50%",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            base_sha,
            head_sha,
            "--",
        ],
    )
    parts = output.split("\0")
    paths: set[str] = set()
    renames: dict[str, str] = {}
    index = 0
    while index < len(parts) and parts[index]:
        status = parts[index]
        index += 1
        if status.startswith(("R", "C")):
            if index + 1 >= len(parts):
                raise GitError("git returned an incomplete rename record")
            before, after = parts[index], parts[index + 1]
            index += 2
            paths.update((before, after))
            if status.startswith("R"):
                renames[before] = after
        else:
            if index >= len(parts):
                raise GitError("git returned an incomplete path record")
            paths.add(parts[index])
            index += 1
    return sorted(paths), renames


def _sql_variables(snapshot: BundleSnapshot, resource: BundleResource) -> dict[str, str]:
    values = {
        str(name): str(value)
        for name, value in snapshot.variables.items()
        if isinstance(value, (str, int, float, bool))
    }
    configuration = resource.config.get("configuration", {})
    if isinstance(configuration, Mapping):
        values.update(
            {
                str(name): str(value)
                for name, value in configuration.items()
                if isinstance(value, (str, int, float, bool))
            }
        )
    for name in ("catalog", "schema"):
        value = resource.config.get(name)
        if isinstance(value, (str, int, float, bool)):
            values.setdefault(name, str(value))
    return values


def _qualify_dataset_name(
    name: str,
    *,
    catalog: str | None,
    schema: str | None,
) -> str | None:
    parts = name.lower().split(".")
    if len(parts) == 3:
        return name.lower()
    if len(parts) == 2 and parts[0] == "live" and catalog and schema:
        return f"{catalog.lower()}.{schema.lower()}.{parts[1]}"
    if len(parts) == 2 and catalog:
        return f"{catalog.lower()}.{name.lower()}"
    if len(parts) == 1 and catalog and schema:
        return f"{catalog.lower()}.{schema.lower()}.{name.lower()}"
    return None


def _qualify_document(
    document: SqlDocumentAnalysis,
    *,
    catalog: str | None,
    schema: str | None,
) -> tuple[SqlDocumentAnalysis, list[tuple[str, str]]]:
    """Apply the selected resource's default namespace to parsed table names."""

    unresolved: list[tuple[str, str]] = []
    statements = []
    for statement in document.statements:
        output = statement.output_dataset
        qualified_output = output
        if output:
            qualified_output = _qualify_dataset_name(output, catalog=catalog, schema=schema)
            if qualified_output is None:
                unresolved.append(("output", output))
                qualified_output = output.lower()

        inputs: list[InputSource] = []
        for source in statement.inputs:
            if source.kind not in {"table", "stream"}:
                inputs.append(source)
                continue
            qualified_source = _qualify_dataset_name(source.name, catalog=catalog, schema=schema)
            if qualified_source is None:
                unresolved.append(("input", source.name))
                qualified_source = source.name.lower()
            inputs.append(replace(source, name=qualified_source))

        namespace_signature = "|".join(
            [
                qualified_output or "",
                *(f"{source.kind}:{source.name}" for source in inputs),
            ]
        )
        semantic_fingerprint = hashlib.sha256(
            f"{statement.semantic_fingerprint}|{namespace_signature}".encode()
        ).hexdigest()
        definition_fingerprint = hashlib.sha256(
            f"{statement.definition_fingerprint}|{namespace_signature}".encode()
        ).hexdigest()
        statements.append(
            replace(
                statement,
                output_dataset=qualified_output,
                inputs=tuple(inputs),
                semantic_fingerprint=semantic_fingerprint,
                definition_fingerprint=definition_fingerprint,
            )
        )
    return replace(document, statements=tuple(statements)), unresolved


def _analyze_revision(repo: Path, snapshot: BundleSnapshot) -> RevisionAnalysis:
    tree = GitRevisionTree(repo, snapshot.commit)
    documents: list[DiscoveredSqlDocument] = []
    issues: list[AnalysisIssue] = [
        AnalysisIssue(
            revision=snapshot.revision,
            source="bundle",
            code=issue.code,
            message=issue.message,
            path=issue.file,
        )
        for issue in snapshot.issues
        if issue.level in {"error", "limitation"}
    ]
    seen: set[tuple[str, str]] = set()
    for resource in snapshot.resources:
        variables = _sql_variables(snapshot, resource)
        catalog_value = resource.config.get("catalog", variables.get("catalog"))
        schema_value = resource.config.get("schema", variables.get("schema"))
        default_catalog = str(catalog_value) if catalog_value else None
        default_schema = str(schema_value) if schema_value else None
        for source in resource.sources:
            for path in source.matches:
                if not path.lower().endswith(".sql"):
                    continue
                key = (resource.identity, path)
                if key in seen:
                    continue
                seen.add(key)
                sql = tree.read(path)
                if sql is None:
                    issues.append(
                        AnalysisIssue(
                            revision=snapshot.revision,
                            source="sql",
                            code="source_blob_missing",
                            message="A bundle-discovered SQL source could not be read",
                            path=path,
                        )
                    )
                    continue
                analysis = parse_sql_document(sql, path=path, variables=variables)
                analysis, unresolved_names = _qualify_document(
                    analysis,
                    catalog=default_catalog,
                    schema=default_schema,
                )
                documents.append(
                    DiscoveredSqlDocument(
                        resource_type=resource.resource_type,
                        resource_key=resource.key,
                        path=path,
                        analysis=analysis,
                    )
                )
                issues.extend(
                    AnalysisIssue(
                        revision=snapshot.revision,
                        source="sql",
                        code=issue.code,
                        message=issue.message,
                        path=path,
                    )
                    for issue in analysis.issues
                )
                issues.extend(
                    AnalysisIssue(
                        revision=snapshot.revision,
                        source="sql",
                        code="unresolved_dataset_namespace",
                        message=(
                            f"Could not qualify {kind} dataset {name!r} from the selected "
                            "resource catalog and schema"
                        ),
                        path=path,
                    )
                    for kind, name in unresolved_names
                )
    return RevisionAnalysis(
        bundle=snapshot,
        documents=tuple(sorted(documents, key=lambda document: document.key)),
        issues=tuple(issues),
    )


def _resource_rename_map(bundle_changes: BundleChangeSet) -> dict[str, str]:
    return {
        change.before.identity: change.after.identity
        for change in bundle_changes.resource_changes
        if change.kind == "renamed" and change.before and change.after
    }


def _pair_documents(
    base: RevisionAnalysis,
    proposed: RevisionAnalysis,
    bundle_changes: BundleChangeSet,
    git_renames: Mapping[str, str],
) -> list[tuple[str, SqlDocumentAnalysis | None, SqlDocumentAnalysis | None]]:
    before = base.document_map
    after = proposed.document_map
    pairs: list[tuple[str, SqlDocumentAnalysis | None, SqlDocumentAnalysis | None]] = []
    used_before: set[tuple[str, str]] = set()
    used_after: set[tuple[str, str]] = set()

    for key in sorted(before.keys() & after.keys()):
        pairs.append((key[0], before[key].analysis, after[key].analysis))
        used_before.add(key)
        used_after.add(key)

    resource_renames = _resource_rename_map(bundle_changes)

    # Pair unique logical outputs before considering Git's similarity hint.
    # This is deterministic even when a file was both moved and edited.
    for old_key, old_document in sorted(before.items()):
        if old_key in used_before:
            continue
        mapped_resource = resource_renames.get(old_key[0], old_key[0])
        old_outputs = set(old_document.analysis.output_datasets)
        candidates = [
            key
            for key, candidate in after.items()
            if key not in used_after
            and key[0] == mapped_resource
            and old_outputs.intersection(candidate.analysis.output_datasets)
        ]
        reverse_matches = (
            [
                key
                for key, candidate in before.items()
                if key not in used_before
                and key[0] == old_key[0]
                and set(after[candidates[0]].analysis.output_datasets).intersection(
                    candidate.analysis.output_datasets
                )
            ]
            if len(candidates) == 1
            else []
        )
        if len(candidates) == len(reverse_matches) == 1:
            new_key = candidates[0]
            pairs.append((new_key[0], old_document.analysis, after[new_key].analysis))
            used_before.add(old_key)
            used_after.add(new_key)

    for old_key, old_document in sorted(before.items()):
        if old_key in used_before:
            continue
        old_resource, old_path = old_key
        candidate_resources = (resource_renames.get(old_resource, old_resource), old_resource)
        candidate_paths = (git_renames.get(old_path, old_path), old_path)
        matches = []
        for resource in candidate_resources:
            for path in candidate_paths:
                new_key = (resource, path)
                if new_key not in after or new_key in used_after:
                    continue
                candidate = after[new_key].analysis
                same_logical_output = bool(
                    set(old_document.analysis.output_datasets).intersection(
                        candidate.output_datasets
                    )
                )
                same_semantics = {
                    statement.semantic_fingerprint for statement in old_document.analysis.statements
                } == {statement.semantic_fingerprint for statement in candidate.statements}
                if same_logical_output or same_semantics:
                    matches.append(new_key)
        if len(set(matches)) == 1:
            new_key = matches[0]
            pairs.append((new_key[0], old_document.analysis, after[new_key].analysis))
            used_before.add(old_key)
            used_after.add(new_key)

    # Content-identical source renames discovered from the bundle are paired even
    # when Git's similarity heuristic did not classify the move.
    for source_change in bundle_changes.source_changes:
        if (
            source_change.kind != "renamed"
            or not source_change.before_path
            or not source_change.after_path
        ):
            continue
        candidates_before = [
            key for key in before if key[1] == source_change.before_path and key not in used_before
        ]
        candidates_after = [
            key for key in after if key[1] == source_change.after_path and key not in used_after
        ]
        if len(candidates_before) == len(candidates_after) == 1:
            old_key, new_key = candidates_before[0], candidates_after[0]
            pairs.append((new_key[0], before[old_key].analysis, after[new_key].analysis))
            used_before.add(old_key)
            used_after.add(new_key)

    pairs.extend(
        (key[0], document.analysis, None)
        for key, document in sorted(before.items())
        if key not in used_before
    )
    pairs.extend(
        (key[0], None, document.analysis)
        for key, document in sorted(after.items())
        if key not in used_after
    )
    return pairs


def _code_edges(proposed: RevisionAnalysis) -> tuple[LineageEdge, ...]:
    edges: list[LineageEdge] = []
    for document in proposed.documents:
        for statement in document.analysis.statements:
            if not statement.output_dataset:
                continue
            target = statement.output_dataset.lower()
            for source in statement.inputs:
                if source.kind not in {"table", "stream"} or source.name == target:
                    continue
                if source.name.count(".") != 2 or target.count(".") != 2:
                    continue
                edges.append(
                    LineageEdge(
                        source_table=source.name.lower(),
                        target_table=target,
                        target_type="PROPOSED_DATASET",
                        level="table",
                        origin=EvidenceOrigin.PROPOSED_CODE,
                    )
                )
    deduplicated = {edge.key: edge for edge in edges}
    return tuple(LineageEdge.model_validate(edge) for edge in deduplicated.values())


def _affected_datasets(
    sql_changes: tuple[SqlChange, ...],
    bundle_changes: BundleChangeSet,
    base: RevisionAnalysis,
    proposed: RevisionAnalysis,
) -> frozenset[str]:
    affected: set[str] = set()
    for item in sql_changes:
        change = item.change
        if change.kind == "unchanged" and not change.definition_changed:
            continue
        for document in (change.base, change.proposed):
            if document:
                affected.update(name.lower() for name in document.output_datasets)

    changed_resources: set[str] = set()
    for change in bundle_changes.resource_changes:
        if change.before:
            changed_resources.add(change.before.identity)
        if change.after:
            changed_resources.add(change.after.identity)
    if bundle_changes.configuration_changes or bundle_changes.variable_changes:
        changed_resources.update(resource.identity for resource in base.bundle.resources)
        changed_resources.update(resource.identity for resource in proposed.bundle.resources)
    if changed_resources:
        for revision in (base, proposed):
            for document in revision.documents:
                if document.resource_identity in changed_resources:
                    affected.update(name.lower() for name in document.analysis.output_datasets)
    return frozenset(affected)


def collect_changes(
    repo: Path,
    base: str,
    head: str,
    *,
    target: str | None = None,
    bundle_file: str = "databricks.yml",
) -> ChangeSet:
    """Discover and compare trusted-base and untrusted-proposed bundle revisions.

    Both revisions are read directly from Git objects. No proposed Python,
    bundle generator, mutator, validation command, or build command is run.
    """

    repo = repo.resolve()
    base_sha = resolve_commit(repo, base)
    head_sha = resolve_commit(repo, head)
    changed_files, git_renames = _changed_paths(repo, base_sha, head_sha)
    base_bundle = discover_bundle(repo, base_sha, target=target, bundle_file=bundle_file)
    proposed_bundle = discover_bundle(repo, head_sha, target=target, bundle_file=bundle_file)
    bundle_changes = compare_bundle_snapshots(base_bundle, proposed_bundle)
    base_analysis = _analyze_revision(repo, base_bundle)
    proposed_analysis = _analyze_revision(repo, proposed_bundle)
    sql_changes = tuple(
        SqlChange(resource_identity=resource, change=compare_sql_documents(old, new))
        for resource, old, new in _pair_documents(
            base_analysis, proposed_analysis, bundle_changes, git_renames
        )
    )

    issues = list(base_analysis.issues) + list(proposed_analysis.issues)
    source_inventory = {
        path
        for snapshot in (base_bundle, proposed_bundle)
        for resource in snapshot.resources
        for source in resource.sources
        for path in source.matches
    }
    for path in sorted(set(changed_files) & source_inventory):
        if not path.lower().endswith(".sql"):
            issues.append(
                AnalysisIssue(
                    revision="comparison",
                    source="source",
                    code="unsupported_changed_source_language",
                    message=(
                        "A changed bundle source is not SQL and cannot be analyzed "
                        "deterministically"
                    ),
                    path=path,
                )
            )

    return ChangeSet(
        base_sha=base_sha,
        head_sha=head_sha,
        target=proposed_bundle.target,
        changed_files=changed_files,
        base=base_analysis,
        proposed=proposed_analysis,
        bundle_changes=bundle_changes,
        sql_changes=sql_changes,
        issues=tuple(issues),
        affected_datasets=_affected_datasets(
            sql_changes, bundle_changes, base_analysis, proposed_analysis
        ),
        proposed_code_edges=_code_edges(proposed_analysis),
    )
