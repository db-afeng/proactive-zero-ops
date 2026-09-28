from __future__ import annotations

import copy
import fnmatch
import hashlib
import json
import posixpath
import re
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol

import yaml

IssueLevel = Literal["error", "limitation", "warning"]
ChangeKind = Literal["added", "deleted", "modified", "renamed"]

_SUBSTITUTION = re.compile(r"\$\{([^{}]+)}")
_GLOB_MAGIC = re.compile(r"[*?[]")
_YAML_SUFFIXES = (".yml", ".yaml")


class BundleDiscoveryError(RuntimeError):
    """The trusted checker could not read the requested Git revision."""


@dataclass(frozen=True)
class DiscoveryIssue:
    code: str
    message: str
    level: IssueLevel = "limitation"
    file: str | None = None
    field: str | None = None


@dataclass(frozen=True)
class SourceReference:
    resource_type: str
    resource_key: str
    kind: str
    declared_path: str
    declaring_file: str
    resolved_path: str | None
    matches: tuple[str, ...] = ()
    content_hashes: tuple[tuple[str, str], ...] = ()
    task_key: str | None = None
    external: bool = False


@dataclass(frozen=True)
class BundleResource:
    resource_type: str
    key: str
    config: Mapping[str, Any]
    declaring_files: tuple[str, ...]
    sources: tuple[SourceReference, ...] = ()

    @property
    def identity(self) -> str:
        return f"{self.resource_type}.{self.key}"


@dataclass(frozen=True)
class BundleSnapshot:
    revision: str
    commit: str
    bundle_file: str
    target: str | None
    variables: Mapping[str, Any]
    configuration: Mapping[str, Any]
    resources: tuple[BundleResource, ...]
    issues: tuple[DiscoveryIssue, ...] = ()
    included_files: tuple[str, ...] = ()

    @property
    def complete(self) -> bool:
        return not any(issue.level in {"error", "limitation"} for issue in self.issues)

    @property
    def resource_map(self) -> dict[str, BundleResource]:
        return {resource.identity: resource for resource in self.resources}


@dataclass(frozen=True)
class FieldChange:
    field: str
    before: Any
    after: Any


@dataclass(frozen=True)
class ResourceChange:
    kind: ChangeKind
    before: BundleResource | None
    after: BundleResource | None
    fields: tuple[FieldChange, ...] = ()


@dataclass(frozen=True)
class SourceChange:
    kind: ChangeKind
    before_path: str | None
    after_path: str | None
    before_hash: str | None = None
    after_hash: str | None = None


@dataclass(frozen=True)
class BundleChangeSet:
    base: BundleSnapshot
    proposed: BundleSnapshot
    configuration_changes: tuple[FieldChange, ...]
    variable_changes: tuple[FieldChange, ...]
    resource_changes: tuple[ResourceChange, ...]
    source_changes: tuple[SourceChange, ...]

    @property
    def complete(self) -> bool:
        return self.base.complete and self.proposed.complete


class RevisionTree(Protocol):
    revision: str
    commit: str

    def files(self) -> tuple[str, ...]: ...

    def read(self, path: str) -> str | None: ...

    def read_bytes(self, path: str) -> bytes | None: ...


class GitRevisionTree:
    """Read-only access to one commit without checking it out or executing its contents."""

    def __init__(self, repo: Path, revision: str):
        self.repo = repo.resolve()
        self.revision = revision
        self.commit = self._git_text(
            "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"
        ).strip()
        raw = self._git_bytes("ls-tree", "-rz", "--name-only", self.commit, "--")
        self._files = tuple(
            sorted(
                part.decode("utf-8", errors="surrogateescape")
                for part in raw.split(b"\0")
                if part
            )
        )
        self._file_set = frozenset(self._files)

    def _git_bytes(self, *args: str, allow_missing: bool = False) -> bytes:
        completed = subprocess.run(
            ["git", *args],
            cwd=self.repo,
            check=False,
            capture_output=True,
        )
        if completed.returncode and not allow_missing:
            message = completed.stderr.decode("utf-8", errors="replace").strip()
            raise BundleDiscoveryError(message or f"git command failed: {' '.join(args)}")
        return completed.stdout

    def _git_text(self, *args: str) -> str:
        return self._git_bytes(*args).decode("utf-8", errors="replace")

    def files(self) -> tuple[str, ...]:
        return self._files

    def read_bytes(self, path: str) -> bytes | None:
        if path not in self._file_set:
            return None
        # The commit has already been reduced to a hexadecimal object ID. The path is selected
        # from ls-tree, so PR content is read as a blob and never interpreted by a shell.
        return self._git_bytes("show", f"{self.commit}:{path}")

    def read(self, path: str) -> str | None:
        content = self.read_bytes(path)
        if content is None:
            return None
        return content.decode("utf-8", errors="replace")


@dataclass
class _Documents:
    merged: dict[str, Any] = field(default_factory=dict)
    origins: dict[tuple[str, ...], str] = field(default_factory=dict)
    files: list[str] = field(default_factory=list)
    issues: list[DiscoveryIssue] = field(default_factory=list)


def discover_bundle(
    repo: Path,
    revision: str,
    *,
    target: str | None = None,
    bundle_file: str = "databricks.yml",
    variable_overrides: Mapping[str, Any] | None = None,
) -> BundleSnapshot:
    """Statically discover bundle resources at a Git revision.

    This function deliberately does not invoke the Databricks CLI, bundle generators, Python,
    artifact builders, mutators, or any command declared by the bundle.
    """

    tree = GitRevisionTree(repo, revision)
    return discover_bundle_tree(
        tree,
        target=target,
        bundle_file=bundle_file,
        variable_overrides=variable_overrides,
    )


def discover_bundle_tree(
    tree: RevisionTree,
    *,
    target: str | None = None,
    bundle_file: str = "databricks.yml",
    variable_overrides: Mapping[str, Any] | None = None,
) -> BundleSnapshot:
    bundle_file = _normalize_repo_path(bundle_file)
    documents = _load_documents(tree, bundle_file)
    merged = documents.merged
    origins = documents.origins
    issues = documents.issues

    _detect_executable_configuration(merged, origins, issues)
    selected_target = _select_target(merged, target, origins, issues)
    effective, effective_origins = _apply_target(merged, origins, selected_target, issues)
    _detect_executable_configuration(effective, effective_origins, issues)
    variables = _resolve_variables(
        merged,
        selected_target,
        variable_overrides or {},
        origins,
        issues,
    )
    resolved = _resolve_configuration(effective, variables, selected_target, origins, issues)
    resources = _discover_resources(tree, resolved, effective_origins, issues)

    return BundleSnapshot(
        revision=tree.revision,
        commit=tree.commit,
        bundle_file=bundle_file,
        target=selected_target,
        variables=variables,
        configuration=resolved,
        resources=tuple(sorted(resources, key=lambda resource: resource.identity)),
        issues=tuple(_deduplicate_issues(issues)),
        included_files=tuple(documents.files),
    )


def compare_bundle_snapshots(base: BundleSnapshot, proposed: BundleSnapshot) -> BundleChangeSet:
    base_global = {key: value for key, value in base.configuration.items() if key != "resources"}
    proposed_global = {
        key: value for key, value in proposed.configuration.items() if key != "resources"
    }
    configuration_changes = tuple(_field_changes(base_global, proposed_global))
    variable_changes = tuple(_field_changes(base.variables, proposed.variables, prefix="variables"))

    before = base.resource_map
    after = proposed.resource_map
    common = sorted(before.keys() & after.keys())
    removed = set(before.keys() - after.keys())
    added = set(after.keys() - before.keys())
    resource_changes: list[ResourceChange] = []

    for identity in common:
        fields = tuple(_field_changes(before[identity].config, after[identity].config))
        source_fields = tuple(
            _field_changes(
                _source_signature(before[identity]),
                _source_signature(after[identity]),
                prefix="sources",
            )
        )
        if fields or source_fields:
            resource_changes.append(
                ResourceChange(
                    kind="modified",
                    before=before[identity],
                    after=after[identity],
                    fields=fields + source_fields,
                )
            )

    # A resource key rename is deterministic only when the resolved configuration and source
    # declaration are identical. Ambiguous matches remain separate additions/deletions.
    rename_candidates: list[tuple[str, str]] = []
    by_fingerprint: dict[str, list[str]] = {}
    for identity in sorted(added):
        by_fingerprint.setdefault(_resource_fingerprint(after[identity]), []).append(identity)
    for old_identity in sorted(removed):
        candidates = by_fingerprint.get(_resource_fingerprint(before[old_identity]), [])
        if len(candidates) == 1:
            new_identity = candidates[0]
            if sum(
                _resource_fingerprint(before[item]) == _resource_fingerprint(before[old_identity])
                for item in removed
            ) == 1:
                rename_candidates.append((old_identity, new_identity))

    for old_identity, new_identity in rename_candidates:
        removed.discard(old_identity)
        added.discard(new_identity)
        resource_changes.append(
            ResourceChange(
                kind="renamed",
                before=before[old_identity],
                after=after[new_identity],
            )
        )
    resource_changes.extend(
        ResourceChange(kind="deleted", before=before[identity], after=None)
        for identity in sorted(removed)
    )
    resource_changes.extend(
        ResourceChange(kind="added", before=None, after=after[identity])
        for identity in sorted(added)
    )

    return BundleChangeSet(
        base=base,
        proposed=proposed,
        configuration_changes=configuration_changes,
        variable_changes=variable_changes,
        resource_changes=tuple(
            sorted(
                resource_changes,
                key=lambda change: (
                    change.before.identity if change.before else "",
                    change.after.identity if change.after else "",
                    change.kind,
                ),
            )
        ),
        source_changes=tuple(_compare_source_files(base, proposed)),
    )


def _load_documents(tree: RevisionTree, bundle_file: str) -> _Documents:
    documents = _Documents()
    available = tree.files()
    queue = [bundle_file]
    visited: set[str] = set()

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        text = tree.read(current)
        if text is None:
            documents.issues.append(
                DiscoveryIssue(
                    code="bundle_file_missing",
                    message=f"Bundle configuration file does not exist at this revision: {current}",
                    level="error",
                    file=current,
                )
            )
            continue
        if not current.endswith(_YAML_SUFFIXES):
            documents.issues.append(
                DiscoveryIssue(
                    code="unsupported_dynamic_include",
                    message=f"Only static YAML includes are supported, not {current}",
                    level="error",
                    file=current,
                )
            )
            continue
        try:
            loaded = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            documents.issues.append(
                DiscoveryIssue(
                    code="invalid_or_unsafe_yaml",
                    message=f"Could not safely parse {current}: {exc}",
                    level="error",
                    file=current,
                )
            )
            continue
        if loaded is None:
            loaded = {}
        if not isinstance(loaded, dict):
            documents.issues.append(
                DiscoveryIssue(
                    code="invalid_bundle_document",
                    message=f"Bundle YAML must contain a mapping: {current}",
                    level="error",
                    file=current,
                )
            )
            continue
        documents.files.append(current)
        _deep_merge(documents.merged, loaded, documents.origins, current)

        include_value = loaded.get("include", [])
        if not isinstance(include_value, list):
            documents.issues.append(
                DiscoveryIssue(
                    code="invalid_include",
                    message="Bundle include must be a list of static paths or globs",
                    level="error",
                    file=current,
                    field="include",
                )
            )
            continue
        for index, pattern in enumerate(include_value):
            if not isinstance(pattern, str) or _SUBSTITUTION.search(pattern):
                documents.issues.append(
                    DiscoveryIssue(
                        code="unsupported_dynamic_include",
                        message=f"Include entry is not a static YAML path: {pattern!r}",
                        level="error",
                        file=current,
                        field=f"include[{index}]",
                    )
                )
                continue
            resolved_pattern = _resolve_declared_path(pattern, current)
            if resolved_pattern is None:
                documents.issues.append(
                    DiscoveryIssue(
                        code="include_outside_repository",
                        message=f"Include escapes the repository: {pattern}",
                        level="error",
                        file=current,
                        field=f"include[{index}]",
                    )
                )
                continue
            matches = tuple(path for path in available if _glob_match(path, resolved_pattern))
            if not matches:
                documents.issues.append(
                    DiscoveryIssue(
                        code="include_no_matches",
                        message=f"Bundle include matched no files: {pattern}",
                        file=current,
                        field=f"include[{index}]",
                    )
                )
            for match in matches:
                if match not in visited and match not in queue:
                    queue.append(match)

    return documents


def _deep_merge(
    destination: dict[str, Any],
    incoming: Mapping[str, Any],
    origins: dict[tuple[str, ...], str],
    source_file: str,
    *,
    destination_prefix: tuple[str, ...] = (),
    source_prefix: tuple[str, ...] = (),
) -> None:
    for key, value in incoming.items():
        key_string = str(key)
        destination_path = (*destination_prefix, key_string)
        source_path = (*source_prefix, key_string)
        origins[destination_path] = origins.get(source_path, source_file)
        existing = destination.get(key_string)
        if isinstance(existing, dict) and isinstance(value, Mapping):
            _deep_merge(
                existing,
                value,
                origins,
                source_file,
                destination_prefix=destination_path,
                source_prefix=source_path,
            )
        else:
            destination[key_string] = copy.deepcopy(value)
            _record_origins(value, origins, source_file, destination_path)


def _record_origins(
    value: Any,
    origins: dict[tuple[str, ...], str],
    source_file: str,
    prefix: tuple[str, ...],
) -> None:
    origins[prefix] = source_file
    if isinstance(value, Mapping):
        for key, child in value.items():
            _record_origins(child, origins, source_file, (*prefix, str(key)))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _record_origins(child, origins, source_file, (*prefix, str(index)))


def _select_target(
    merged: Mapping[str, Any],
    requested: str | None,
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
) -> str | None:
    targets = merged.get("targets", {})
    if not isinstance(targets, Mapping):
        issues.append(
            DiscoveryIssue(
                code="invalid_targets",
                message="Bundle targets must be a mapping",
                level="error",
                file=_origin_for(origins, ("targets",)),
                field="targets",
            )
        )
        return None
    if requested is not None:
        if requested not in targets:
            issues.append(
                DiscoveryIssue(
                    code="target_not_found",
                    message=f"Selected bundle target does not exist: {requested}",
                    level="error",
                    field=f"targets.{requested}",
                )
            )
            return requested
        return requested
    defaults = [
        str(name)
        for name, config in targets.items()
        if isinstance(config, Mapping) and config.get("default") is True
    ]
    if len(defaults) == 1:
        return defaults[0]
    if len(defaults) > 1:
        issues.append(
            DiscoveryIssue(
                code="multiple_default_targets",
                message=f"Bundle has multiple default targets: {', '.join(sorted(defaults))}",
                level="error",
                field="targets",
            )
        )
    elif len(targets) == 1:
        return str(next(iter(targets)))
    elif len(targets) > 1:
        issues.append(
            DiscoveryIssue(
                code="target_required",
                message="Bundle has multiple targets and none was selected or marked default",
                level="error",
                field="targets",
            )
        )
    return None


def _apply_target(
    merged: Mapping[str, Any],
    origins: Mapping[tuple[str, ...], str],
    target: str | None,
    issues: list[DiscoveryIssue],
) -> tuple[dict[str, Any], dict[tuple[str, ...], str]]:
    effective = copy.deepcopy(dict(merged))
    effective.pop("targets", None)
    effective_origins = {
        path: source for path, source in origins.items() if not path or path[0] != "targets"
    }
    if target is None:
        return effective, effective_origins
    target_value = merged.get("targets", {}).get(target, {})  # type: ignore[union-attr]
    if not isinstance(target_value, Mapping):
        issues.append(
            DiscoveryIssue(
                code="invalid_target",
                message=f"Target {target} must contain a mapping",
                level="error",
                file=_origin_for(origins, ("targets", target)),
                field=f"targets.{target}",
            )
        )
        return effective, effective_origins
    overrides = {
        str(key): value
        for key, value in target_value.items()
        if key not in {"default", "variables"}
    }
    # Remap target-field origins to the effective top-level fields they override.
    target_origins: dict[tuple[str, ...], str] = {}
    for path, source in origins.items():
        prefix = ("targets", target)
        if path[: len(prefix)] == prefix and len(path) > len(prefix):
            target_origins[path[len(prefix) :]] = source
    target_origin = _origin_for(origins, ("targets", target)) or ""
    _deep_merge(effective, overrides, target_origins, target_origin)
    effective_origins.update(target_origins)
    return effective, effective_origins


def _resolve_variables(
    merged: Mapping[str, Any],
    target: str | None,
    supplied: Mapping[str, Any],
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
) -> dict[str, Any]:
    declarations = merged.get("variables", {})
    if declarations is None:
        declarations = {}
    if not isinstance(declarations, Mapping):
        issues.append(
            DiscoveryIssue(
                code="invalid_variables",
                message="Bundle variables must be a mapping",
                level="error",
                file=_origin_for(origins, ("variables",)),
                field="variables",
            )
        )
        declarations = {}
    values: dict[str, Any] = {}
    for name, declaration in declarations.items():
        if isinstance(declaration, Mapping):
            if "default" in declaration:
                values[str(name)] = copy.deepcopy(declaration["default"])
            elif "lookup" in declaration:
                issues.append(
                    DiscoveryIssue(
                        code="unsupported_dynamic_variable",
                        message=f"Variable {name} requires a workspace lookup",
                        file=_origin_for(origins, ("variables", str(name))),
                        field=f"variables.{name}",
                    )
                )
            else:
                issues.append(
                    DiscoveryIssue(
                        code="unresolved_variable",
                        message=f"Variable {name} has no static default",
                        file=_origin_for(origins, ("variables", str(name))),
                        field=f"variables.{name}",
                    )
                )
        else:
            values[str(name)] = copy.deepcopy(declaration)

    if target is not None:
        target_variables = merged.get("targets", {}).get(target, {}).get("variables", {})  # type: ignore[union-attr]
        if not isinstance(target_variables, Mapping):
            issues.append(
                DiscoveryIssue(
                    code="invalid_target_variables",
                    message=f"Variables for target {target} must be a mapping",
                    level="error",
                    file=_origin_for(origins, ("targets", target, "variables")),
                    field=f"targets.{target}.variables",
                )
            )
        else:
            for name, value in target_variables.items():
                if isinstance(value, Mapping) and "lookup" in value:
                    issues.append(
                        DiscoveryIssue(
                            code="unsupported_dynamic_variable",
                            message=f"Target variable {name} requires a workspace lookup",
                            file=_origin_for(
                                origins, ("targets", target, "variables", str(name))
                            ),
                            field=f"targets.{target}.variables.{name}",
                        )
                    )
                    continue
                values[str(name)] = copy.deepcopy(value)
    values.update(copy.deepcopy(dict(supplied)))
    return values


def _resolve_configuration(
    effective: Mapping[str, Any],
    variables: Mapping[str, Any],
    target: str | None,
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
) -> dict[str, Any]:
    result: Any = copy.deepcopy(effective)
    for _ in range(20):
        changed = False
        current_result = result

        def lookup(token: str, current: Any = current_result) -> Any:
            if token.startswith("var."):
                return variables.get(token[4:], _UNRESOLVED)
            if token == "bundle.target":
                return target if target is not None else _UNRESOLVED
            if token == "bundle.name":
                bundle = current.get("bundle", {}) if isinstance(current, Mapping) else {}
                if isinstance(bundle, Mapping):
                    return bundle.get("name", _UNRESOLVED)
                return _UNRESOLVED
            if token.startswith("resources."):
                return _lookup_path(current, token.split("."))
            return _UNRESOLVED

        result, changed = _substitute_node(result, lookup)
        if not changed:
            break

    for path, value in _walk_scalars(result):
        if not isinstance(value, str):
            continue
        for match in _SUBSTITUTION.finditer(value):
            token = match.group(1)
            dynamic = token.startswith(("workspace.", "secrets.", "env.")) or token.endswith(
                ".id"
            )
            issues.append(
                DiscoveryIssue(
                    code=(
                        "unsupported_dynamic_substitution"
                        if dynamic
                        else "unresolved_substitution"
                    ),
                    message=f"Could not statically resolve ${{{token}}}",
                    file=_origin_for(origins, path),
                    field=".".join(path),
                )
            )
    return result


class _Unresolved:
    pass


_UNRESOLVED = _Unresolved()


def _substitute_node(node: Any, lookup: Any) -> tuple[Any, bool]:
    if isinstance(node, dict):
        changed = False
        result: dict[str, Any] = {}
        for key, value in node.items():
            resolved, child_changed = _substitute_node(value, lookup)
            result[str(key)] = resolved
            changed = changed or child_changed
        return result, changed
    if isinstance(node, list):
        changed = False
        result_list: list[Any] = []
        for value in node:
            resolved, child_changed = _substitute_node(value, lookup)
            result_list.append(resolved)
            changed = changed or child_changed
        return result_list, changed
    if not isinstance(node, str):
        return node, False
    matches = list(_SUBSTITUTION.finditer(node))
    if not matches:
        return node, False
    if len(matches) == 1 and matches[0].span() == (0, len(node)):
        value = lookup(matches[0].group(1))
        if value is not _UNRESOLVED and value != node:
            return copy.deepcopy(value), True
        return node, False
    result = node
    changed = False
    for match in matches:
        value = lookup(match.group(1))
        if value is not _UNRESOLVED:
            result = result.replace(match.group(0), str(value))
            changed = True
    return result, changed


def _discover_resources(
    tree: RevisionTree,
    resolved: Mapping[str, Any],
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
) -> list[BundleResource]:
    resource_root = resolved.get("resources", {})
    if resource_root is None:
        return []
    if not isinstance(resource_root, Mapping):
        issues.append(
            DiscoveryIssue(
                code="invalid_resources",
                message="Bundle resources must be a mapping",
                level="error",
                file=_origin_for(origins, ("resources",)),
                field="resources",
            )
        )
        return []
    resources: list[BundleResource] = []
    for resource_type, values in resource_root.items():
        if not isinstance(values, Mapping):
            issues.append(
                DiscoveryIssue(
                    code="invalid_resource_collection",
                    message=f"resources.{resource_type} must be a mapping",
                    level="error",
                    file=_origin_for(origins, ("resources", str(resource_type))),
                    field=f"resources.{resource_type}",
                )
            )
            continue
        for key, config in values.items():
            resource_path = ("resources", str(resource_type), str(key))
            if not isinstance(config, Mapping):
                issues.append(
                    DiscoveryIssue(
                        code="invalid_resource",
                        message=f"{'.'.join(resource_path)} must be a mapping",
                        level="error",
                        file=_origin_for(origins, resource_path),
                        field=".".join(resource_path),
                    )
                )
                continue
            declaring_files = tuple(
                sorted(
                    {
                        source
                        for path, source in origins.items()
                        if path[: len(resource_path)] == resource_path
                    }
                )
            )
            sources: list[SourceReference] = []
            if resource_type == "pipelines":
                sources.extend(
                    _pipeline_sources(
                        tree, str(key), config, resource_path, origins, issues
                    )
                )
            elif resource_type == "jobs":
                sources.extend(
                    _job_sources(tree, str(key), config, resource_path, origins, issues)
                )
            resources.append(
                BundleResource(
                    resource_type=str(resource_type),
                    key=str(key),
                    config=copy.deepcopy(dict(config)),
                    declaring_files=declaring_files,
                    sources=tuple(sources),
                )
            )
    return resources


def _pipeline_sources(
    tree: RevisionTree,
    resource_key: str,
    config: Mapping[str, Any],
    resource_path: tuple[str, ...],
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
) -> list[SourceReference]:
    result: list[SourceReference] = []
    root_path = config.get("root_path")
    if root_path is not None:
        result.extend(
            _make_source(
                tree,
                "pipelines",
                resource_key,
                "pipeline_root",
                root_path,
                (*resource_path, "root_path"),
                origins,
                issues,
                expand_directory=False,
            )
        )
    libraries = config.get("libraries", [])
    if not isinstance(libraries, list):
        issues.append(
            DiscoveryIssue(
                code="invalid_pipeline_libraries",
                message=f"Pipeline {resource_key} libraries must be a list",
                level="error",
                file=_origin_for(origins, (*resource_path, "libraries")),
                field=".".join((*resource_path, "libraries")),
            )
        )
        return result
    for index, library in enumerate(libraries):
        path = (*resource_path, "libraries", str(index))
        if not isinstance(library, Mapping):
            issues.append(
                DiscoveryIssue(
                    code="unsupported_pipeline_library",
                    message=f"Pipeline library entry is not a mapping: {library!r}",
                    file=_origin_for(origins, path),
                    field=".".join(path),
                )
            )
            continue
        discovered = False
        for key in ("notebook", "file", "glob"):
            entry = library.get(key)
            entry_path = (*path, key)
            if isinstance(entry, Mapping):
                path_key = "include" if key == "glob" else "path"
                if path_key in entry:
                    discovered = True
                    result.extend(
                        _make_source(
                            tree,
                            "pipelines",
                            resource_key,
                            f"pipeline_{key}",
                            entry[path_key],
                            (*entry_path, path_key),
                            origins,
                            issues,
                        )
                    )
        if not discovered and not any(key in library for key in ("jar", "maven", "whl")):
            issues.append(
                DiscoveryIssue(
                    code="unsupported_pipeline_library",
                    message=f"Pipeline library type is not supported: {sorted(library)}",
                    file=_origin_for(origins, path),
                    field=".".join(path),
                )
            )
        for key in ("jar", "whl"):
            if key in library:
                result.extend(
                    _make_source(
                        tree,
                        "pipelines",
                        resource_key,
                        f"pipeline_{key}",
                        library[key],
                        (*path, key),
                        origins,
                        issues,
                    )
                )
    return result


def _job_sources(
    tree: RevisionTree,
    resource_key: str,
    config: Mapping[str, Any],
    resource_path: tuple[str, ...],
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
) -> list[SourceReference]:
    tasks = config.get("tasks", [])
    if not isinstance(tasks, list):
        issues.append(
            DiscoveryIssue(
                code="invalid_job_tasks",
                message=f"Job {resource_key} tasks must be a list",
                level="error",
                file=_origin_for(origins, (*resource_path, "tasks")),
                field=".".join((*resource_path, "tasks")),
            )
        )
        return []
    result: list[SourceReference] = []
    for index, task in enumerate(tasks):
        path = (*resource_path, "tasks", str(index))
        if not isinstance(task, Mapping):
            issues.append(
                DiscoveryIssue(
                    code="invalid_job_task",
                    message=f"Job task entry is not a mapping: {task!r}",
                    level="error",
                    file=_origin_for(origins, path),
                    field=".".join(path),
                )
            )
            continue
        task_key = str(task.get("task_key", index))
        task_fields = (
            ("notebook_task", "notebook_path", "job_notebook"),
            ("spark_python_task", "python_file", "job_python"),
            ("spark_submit_task", "parameters", "job_spark_submit_parameter"),
            ("dbt_task", "project_directory", "job_dbt_project"),
        )
        for task_type, field_name, kind in task_fields:
            task_config = task.get(task_type)
            if not isinstance(task_config, Mapping) or field_name not in task_config:
                continue
            value = task_config[field_name]
            if task_type == "spark_submit_task":
                if not isinstance(value, list):
                    continue
                for parameter_index, parameter in enumerate(value):
                    if not isinstance(parameter, str) or not _looks_like_local_path(parameter):
                        continue
                    result.extend(
                        _make_source(
                            tree,
                            "jobs",
                            resource_key,
                            kind,
                            parameter,
                            (*path, task_type, field_name, str(parameter_index)),
                            origins,
                            issues,
                            task_key=task_key,
                        )
                    )
            else:
                result.extend(
                    _make_source(
                        tree,
                        "jobs",
                        resource_key,
                        kind,
                        value,
                        (*path, task_type, field_name),
                        origins,
                        issues,
                        task_key=task_key,
                        expand_directory=task_type == "dbt_task",
                    )
                )

        sql_task = task.get("sql_task")
        if isinstance(sql_task, Mapping):
            file_config = sql_task.get("file")
            if isinstance(file_config, Mapping) and "path" in file_config:
                result.extend(
                    _make_source(
                        tree,
                        "jobs",
                        resource_key,
                        "job_sql",
                        file_config["path"],
                        (*path, "sql_task", "file", "path"),
                        origins,
                        issues,
                        task_key=task_key,
                    )
                )
        result.extend(
            _library_sources(
                tree,
                resource_key,
                task.get("libraries", []),
                (*path, "libraries"),
                origins,
                issues,
                task_key,
            )
        )
    result.extend(
        _library_sources(
            tree,
            resource_key,
            config.get("libraries", []),
            (*resource_path, "libraries"),
            origins,
            issues,
            None,
        )
    )
    return result


def _library_sources(
    tree: RevisionTree,
    resource_key: str,
    libraries: Any,
    path: tuple[str, ...],
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
    task_key: str | None,
) -> list[SourceReference]:
    if libraries in (None, []):
        return []
    if not isinstance(libraries, list):
        issues.append(
            DiscoveryIssue(
                code="invalid_job_libraries",
                message=f"Job {resource_key} libraries must be a list",
                level="error",
                file=_origin_for(origins, path),
                field=".".join(path),
            )
        )
        return []
    result: list[SourceReference] = []
    for index, library in enumerate(libraries):
        entry_path = (*path, str(index))
        if not isinstance(library, Mapping):
            continue
        for key in ("whl", "jar", "egg", "requirements"):
            if key not in library:
                continue
            result.extend(
                _make_source(
                    tree,
                    "jobs",
                    resource_key,
                    f"job_library_{key}",
                    library[key],
                    (*entry_path, key),
                    origins,
                    issues,
                    task_key=task_key,
                )
            )
    return result


def _make_source(
    tree: RevisionTree,
    resource_type: str,
    resource_key: str,
    kind: str,
    value: Any,
    field_path: tuple[str, ...],
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
    *,
    task_key: str | None = None,
    expand_directory: bool = False,
) -> list[SourceReference]:
    declaring_file = _origin_for(origins, field_path) or "databricks.yml"
    field_name = ".".join(field_path)
    if not isinstance(value, str):
        issues.append(
            DiscoveryIssue(
                code="invalid_source_path",
                message=f"Source path must be a string: {value!r}",
                level="error",
                file=declaring_file,
                field=field_name,
            )
        )
        return []
    if _SUBSTITUTION.search(value):
        issues.append(
            DiscoveryIssue(
                code="unresolved_source_path",
                message=f"Source path contains an unresolved substitution: {value}",
                file=declaring_file,
                field=field_name,
            )
        )
        return [
            SourceReference(
                resource_type=resource_type,
                resource_key=resource_key,
                kind=kind,
                declared_path=value,
                declaring_file=declaring_file,
                resolved_path=None,
                task_key=task_key,
            )
        ]
    if _is_external_path(value):
        issues.append(
            DiscoveryIssue(
                code="external_source_not_inspected",
                message=f"Source is outside this Git revision and was not inspected: {value}",
                file=declaring_file,
                field=field_name,
            )
        )
        return [
            SourceReference(
                resource_type=resource_type,
                resource_key=resource_key,
                kind=kind,
                declared_path=value,
                declaring_file=declaring_file,
                resolved_path=value,
                task_key=task_key,
                external=True,
            )
        ]
    resolved = _resolve_declared_path(value, declaring_file)
    if resolved is None:
        issues.append(
            DiscoveryIssue(
                code="source_outside_repository",
                message=f"Source path escapes the repository: {value}",
                level="error",
                file=declaring_file,
                field=field_name,
            )
        )
        return [
            SourceReference(
                resource_type=resource_type,
                resource_key=resource_key,
                kind=kind,
                declared_path=value,
                declaring_file=declaring_file,
                resolved_path=None,
                task_key=task_key,
            )
        ]

    available = tree.files()
    if _GLOB_MAGIC.search(resolved):
        matches = tuple(path for path in available if _glob_match(path, resolved))
    elif expand_directory:
        prefix = resolved.rstrip("/") + "/"
        matches = tuple(path for path in available if path == resolved or path.startswith(prefix))
    elif resolved in available:
        matches = (resolved,)
    else:
        matches = ()

    if not matches and kind != "pipeline_root":
        issues.append(
            DiscoveryIssue(
                code="source_no_matches",
                message=f"Source path matched no files at {tree.revision}: {value}",
                file=declaring_file,
                field=field_name,
            )
        )
    hashes = tuple(
        (match, hashlib.sha256(content).hexdigest())
        for match in matches
        if (content := tree.read_bytes(match)) is not None
    )
    return [
        SourceReference(
            resource_type=resource_type,
            resource_key=resource_key,
            kind=kind,
            declared_path=value,
            declaring_file=declaring_file,
            resolved_path=resolved,
            matches=matches,
            content_hashes=hashes,
            task_key=task_key,
        )
    ]


def _detect_executable_configuration(
    merged: Mapping[str, Any],
    origins: Mapping[tuple[str, ...], str],
    issues: list[DiscoveryIssue],
) -> None:
    scripts = merged.get("scripts")
    if scripts:
        issues.append(
            DiscoveryIssue(
                code="unsupported_executable_configuration",
                message="Bundle scripts are not executed or interpreted by the lineage guard",
                file=_origin_for(origins, ("scripts",)),
                field="scripts",
            )
        )
    experimental = merged.get("experimental")
    if isinstance(experimental, Mapping) and any(
        key in experimental for key in ("python", "mutators", "mutator")
    ):
        issues.append(
            DiscoveryIssue(
                code="unsupported_bundle_mutator",
                message="Python or other bundle mutators are unsupported in privileged assessment",
                level="error",
                file=_origin_for(origins, ("experimental",)),
                field="experimental",
            )
        )
    artifacts = merged.get("artifacts", {})
    if isinstance(artifacts, Mapping):
        for key, artifact in artifacts.items():
            if isinstance(artifact, Mapping) and artifact.get("build"):
                issues.append(
                    DiscoveryIssue(
                        code="unsupported_artifact_build",
                        message=f"Artifact build command is not executed: {key}",
                        file=_origin_for(origins, ("artifacts", str(key), "build")),
                        field=f"artifacts.{key}.build",
                    )
                )


def _field_changes(before: Any, after: Any, prefix: str = "") -> list[FieldChange]:
    if isinstance(before, Mapping) and isinstance(after, Mapping):
        changes: list[FieldChange] = []
        for key in sorted(set(before) | set(after), key=str):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in before:
                changes.append(FieldChange(path, None, copy.deepcopy(after[key])))
            elif key not in after:
                changes.append(FieldChange(path, copy.deepcopy(before[key]), None))
            else:
                changes.extend(_field_changes(before[key], after[key], path))
        return changes
    if isinstance(before, list) and isinstance(after, list):
        if before == after:
            return []
        return [FieldChange(prefix, copy.deepcopy(before), copy.deepcopy(after))]
    if before != after:
        return [FieldChange(prefix, copy.deepcopy(before), copy.deepcopy(after))]
    return []


def _compare_source_files(base: BundleSnapshot, proposed: BundleSnapshot) -> list[SourceChange]:
    before = _source_file_inventory(base)
    after = _source_file_inventory(proposed)
    common = before.keys() & after.keys()
    changes = [
        SourceChange("modified", path, path, before[path], after[path])
        for path in sorted(common)
        if before[path] != after[path]
    ]
    removed = set(before.keys() - after.keys())
    added = set(after.keys() - before.keys())
    by_hash: dict[str, list[str]] = {}
    for path in added:
        by_hash.setdefault(after[path], []).append(path)
    for old_path in sorted(tuple(removed)):
        candidates = sorted(by_hash.get(before[old_path], []))
        matching_removed = [path for path in removed if before[path] == before[old_path]]
        if len(candidates) == 1 and len(matching_removed) == 1:
            new_path = candidates[0]
            removed.remove(old_path)
            added.remove(new_path)
            changes.append(
                SourceChange("renamed", old_path, new_path, before[old_path], after[new_path])
            )
    changes.extend(
        SourceChange("deleted", path, None, before[path], None) for path in sorted(removed)
    )
    changes.extend(SourceChange("added", None, path, None, after[path]) for path in sorted(added))
    return sorted(
        changes,
        key=lambda item: (item.before_path or "", item.after_path or "", item.kind),
    )


def _source_file_inventory(snapshot: BundleSnapshot) -> dict[str, str]:
    inventory: dict[str, str] = {}
    for resource in snapshot.resources:
        for source in resource.sources:
            inventory.update(dict(source.content_hashes))
    return inventory


def _source_signature(resource: BundleResource) -> list[dict[str, Any]]:
    return [
        {
            "kind": source.kind,
            "declared_path": source.declared_path,
            "resolved_path": source.resolved_path,
            "task_key": source.task_key,
            "external": source.external,
        }
        for source in resource.sources
    ]


def _resource_fingerprint(resource: BundleResource) -> str:
    value = {"config": resource.config, "sources": _source_signature(resource)}
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def _lookup_path(value: Any, path: list[str]) -> Any:
    current = value
    for part in path:
        if not isinstance(current, Mapping) or part not in current:
            return _UNRESOLVED
        current = current[part]
    return current


def _walk_scalars(value: Any, prefix: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], Any]]:
    result: list[tuple[tuple[str, ...], Any]] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            result.extend(_walk_scalars(child, (*prefix, str(key))))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            result.extend(_walk_scalars(child, (*prefix, str(index))))
    else:
        result.append((prefix, value))
    return result


def _origin_for(origins: Mapping[tuple[str, ...], str], path: tuple[str, ...]) -> str | None:
    current = path
    while current:
        if current in origins:
            return origins[current]
        current = current[:-1]
    return None


def _resolve_declared_path(path: str, declaring_file: str) -> str | None:
    path = path.replace("\\", "/")
    combined = posixpath.normpath(posixpath.join(posixpath.dirname(declaring_file), path))
    if combined == ".." or combined.startswith("../") or combined.startswith("/"):
        return None
    return combined.removeprefix("./")


def _normalize_repo_path(path: str) -> str:
    normalized = PurePosixPath(path.replace("\\", "/"))
    if normalized.is_absolute() or ".." in normalized.parts:
        raise BundleDiscoveryError(f"Bundle path must be repository-relative: {path}")
    return normalized.as_posix()


def _is_external_path(path: str) -> bool:
    lowered = path.lower()
    return path.startswith("/") or lowered.startswith(
        (
            "dbfs:/",
            "s3://",
            "abfss://",
            "gs://",
            "http://",
            "https://",
            "file:/",
            "workspace:/",
        )
    )


def _looks_like_local_path(value: str) -> bool:
    return (
        not value.startswith("-")
        and not _is_external_path(value)
        and ("/" in value or bool(PurePosixPath(value).suffix))
    )


def _glob_match(path: str, pattern: str) -> bool:
    """Match bundle globs with `**/` accepting zero or more directories.

    Python's fnmatch requires at least one directory for `**/`, while bundle globs use the
    conventional recursive meaning where zero directories is also valid.
    """

    alternatives = {pattern}
    pending = [pattern]
    while pending:
        candidate = pending.pop()
        start = 0
        while (start := candidate.find("**/", start)) >= 0:
            without_segment = candidate[:start] + candidate[start + 3 :]
            if without_segment not in alternatives:
                alternatives.add(without_segment)
                pending.append(without_segment)
            start += 3
    return any(fnmatch.fnmatchcase(path, candidate) for candidate in alternatives)


def _deduplicate_issues(issues: list[DiscoveryIssue]) -> list[DiscoveryIssue]:
    seen: set[tuple[Any, ...]] = set()
    result: list[DiscoveryIssue] = []
    for issue in issues:
        key = (issue.code, issue.message, issue.level, issue.file, issue.field)
        if key not in seen:
            result.append(issue)
            seen.add(key)
    return result
