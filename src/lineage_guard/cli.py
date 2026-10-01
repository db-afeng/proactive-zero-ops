from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

from lineage_guard.ai import AIGatewayAssessor, discover_endpoint
from lineage_guard.config import load_config
from lineage_guard.disclosure import (
    AssessmentSource,
    RestrictedEvidenceStore,
    deserialize_public_artifact,
    prepare_disclosures,
    render_public_log,
    render_public_markdown,
    serialize_public_artifact,
)
from lineage_guard.display_evidence import build_display_evidence
from lineage_guard.evaluate import evaluate_assessment
from lineage_guard.gitdiff import ChangeSet, collect_changes
from lineage_guard.lineage import LineageGraph, LineageRepository, StatementExecutor
from lineage_guard.models import (
    DiscoveryCertainty,
    EvidenceOrigin,
    GuardResult,
    Severity,
)
from lineage_guard.publication import (
    DEFAULT_RESTRICTED_VOLUME_ROOT,
    publish_restricted_evidence,
    reference_from_public_artifact,
    validate_publication_receipt,
    write_private_publication_receipt,
)

# Enforcement and disclosure policy live in trusted base-branch code. They are
# intentionally not read from a pull-request-controlled bundle or manifest.
LINEAGE_LOOKBACK_DAYS = 30
BLOCK_CONFIDENCE = 0.80
MAX_CONTEXT_CHARACTERS = 100_000


def _bundle_change_evidence(changes: ChangeSet) -> dict[str, Any]:
    bundle = changes.bundle_changes
    return {
        "configuration_changes": [asdict(change) for change in bundle.configuration_changes],
        "variable_changes": [asdict(change) for change in bundle.variable_changes],
        "resource_changes": [asdict(change) for change in bundle.resource_changes],
        "source_changes": [asdict(change) for change in bundle.source_changes],
    }


def _semantic_change_evidence(changes: ChangeSet) -> list[dict[str, Any]]:
    return [asdict(change) for change in changes.meaningful_sql_changes]


def _compact_column(column: Any | None) -> dict[str, Any] | None:
    if column is None:
        return None
    return {
        "name": column.name,
        "expression": column.expression_sql,
        "source_columns": list(column.source_columns),
        "wildcard": column.wildcard,
    }


def _compact_statement(statement: Any) -> dict[str, Any]:
    return {
        "statement_kind": statement.statement_kind,
        "output_dataset": statement.output_dataset,
        "inputs": [asdict(source) for source in statement.inputs],
        "output_columns": [_compact_column(column) for column in statement.output_columns],
        "joins": [asdict(join) for join in statement.joins],
        "filters": [asdict(item) for item in statement.filters],
        "explicit_casts": [asdict(item) for item in statement.explicit_casts],
        "expectations": [
            {
                "name": item.name,
                "expression": item.expression_sql,
                "action": item.action,
            }
            for item in statement.expectations
        ],
        "source_evidence": statement.evidence_sql,
    }


def _semantic_change_context(changes: ChangeSet) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for item in changes.meaningful_sql_changes:
        change = item.change
        compact.append(
            {
                "resource": item.resource_identity,
                "kind": change.kind,
                "base_path": item.before_path,
                "proposed_path": item.after_path,
                "semantic_changed": change.semantic_changed,
                "definition_changed": change.definition_changed,
                "statements": [
                    {
                        "kind": statement.kind,
                        "base": (_compact_statement(statement.base) if statement.base else None),
                        "proposed": (
                            _compact_statement(statement.proposed) if statement.proposed else None
                        ),
                        "column_changes": [
                            {
                                "kind": column.kind,
                                "base_name": column.base_name,
                                "proposed_name": column.proposed_name,
                                "base": _compact_column(column.base),
                                "proposed": _compact_column(column.proposed),
                            }
                            for column in statement.column_changes
                        ],
                        "added_inputs": [asdict(source) for source in statement.added_inputs],
                        "removed_inputs": [asdict(source) for source in statement.removed_inputs],
                        "joins_changed": statement.joins_changed,
                        "filters_changed": statement.filters_changed,
                        "casts_changed": statement.casts_changed,
                        "expectations_changed": statement.expectations_changed,
                    }
                    for statement in change.statement_changes
                ],
            }
        )
    return compact


def _compact_edge(edge: Any) -> dict[str, Any]:
    return {
        "source_asset": edge.source_table,
        "source_column": edge.source_column,
        "target_asset": edge.target_table,
        "target_column": edge.target_column,
        "target_type": edge.target_type,
        "level": edge.level,
        "origin": edge.origin.value,
    }


def _downstream_definitions(
    changes: ChangeSet, graph: LineageGraph
) -> dict[str, list[dict[str, Any]]]:
    wanted = graph.downstream_tables() | set(changes.affected_datasets)
    definitions: dict[str, list[dict[str, Any]]] = {}
    for document in changes.proposed.documents:
        for statement in document.analysis.statements:
            if statement.output_dataset and statement.output_dataset.lower() in wanted:
                definitions.setdefault(statement.output_dataset.lower(), []).append(
                    _compact_statement(statement)
                )
    return definitions


def _assessment_context(
    changes: ChangeSet,
    observed: LineageGraph,
    verified: LineageGraph,
    max_depth: int,
) -> dict[str, Any]:
    paths = verified.paths_from(changes.affected_datasets, max_depth)
    context = {
        "scope": {
            "bundle_target": changes.target,
            "base_revision": changes.base_sha,
            "proposed_revision": changes.head_sha,
            "affected_datasets": sorted(changes.affected_datasets),
        },
        "discovery": {
            "complete": changes.complete,
            "certainty": "complete" if changes.complete else "incomplete",
            "limitations": [asdict(issue) for issue in changes.issues],
        },
        "bundle_changes": _bundle_change_evidence(changes),
        "structured_sql_changes": _semantic_change_context(changes),
        "dependencies": {
            "proposed_code": [_compact_edge(edge) for edge in changes.proposed_code_edges],
            "observed_prior_executions": [_compact_edge(edge) for edge in observed.edges],
        },
        "verified_dependency_paths": [
            {"assets": path, "hops": verified.path_evidence(path)} for path in paths
        ],
        "downstream_definitions_from_proposed_repository": _downstream_definitions(
            changes, verified
        ),
        "interpretation_policy": {
            "block_severities": ["high", "critical"],
            "block_confidence": BLOCK_CONFIDENCE,
            "path_identity_and_hops_are_deterministically_verified": True,
            "discovery_certainty_is_not_model_confidence": True,
        },
    }
    serialized = json.dumps(context, sort_keys=True, default=str)
    if len(serialized) > MAX_CONTEXT_CHARACTERS:
        raise RuntimeError(
            f"assessment context is {len(serialized)} characters, exceeding the trusted limit"
        )
    return context


def _restricted_payload(
    result: GuardResult,
    changes: ChangeSet | None,
    *,
    model_assessment: Any | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "result": result.model_dump(mode="json"),
        "display_evidence": build_display_evidence(result, changes).model_dump(mode="json"),
        "identity_semantics": {
            "assessment_principal": "service_principal",
            "on_behalf_of_user": False,
        },
    }
    if changes is not None:
        payload["discovery"] = changes.restricted_evidence()
    if model_assessment is not None:
        payload["model_assessment"] = model_assessment.model_dump(mode="json")
    return payload


def _publish(
    result: GuardResult,
    evidence: dict[str, Any],
    *,
    source: AssessmentSource,
    output: Path,
    markdown_output: Path,
    restricted_dir: Path,
) -> int:
    disclosures = prepare_disclosures(status=result.status, evidence=evidence, source=source)
    try:
        RestrictedEvidenceStore(restricted_dir).write(disclosures.restricted)
    except Exception:
        # A report whose full evidence could not be retained under the required
        # permission boundary cannot be published as a successful assessment.
        result = GuardResult(
            status="error",
            summary="Restricted assessment evidence could not be stored safely.",
            assessment_complete=False,
            discovery_certainty=DiscoveryCertainty.INCOMPLETE,
            error="restricted evidence persistence failed",
        )
        disclosures = prepare_disclosures(
            status=result.status,
            evidence={"result": result},
            source=source,
        )

    output.write_bytes(serialize_public_artifact(disclosures.public))
    markdown_output.write_text(render_public_markdown(disclosures.public), encoding="utf-8")
    print(render_public_log(disclosures.public))
    return result.exit_code


def _error_result(message: str, changed_files: list[str] | None = None) -> GuardResult:
    return GuardResult(
        status="error",
        severity=Severity.NONE,
        summary="The downstream impact assessment could not be completed safely.",
        assessment_complete=False,
        discovery_certainty=DiscoveryCertainty.INCOMPLETE,
        changed_files=changed_files or [],
        coverage_limitations=[message],
        error=message,
    )


def assess(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    output = Path(args.output).resolve()
    markdown_output = Path(args.markdown_output).resolve()
    restricted_dir_value = args.restricted_evidence_dir or os.environ.get(
        "LINEAGE_GUARD_RESTRICTED_DIR"
    )
    restricted_dir = (
        Path(restricted_dir_value).resolve()
        if restricted_dir_value
        else (repo / ".lineage-guard-restricted").resolve()
    )
    changes: ChangeSet | None = None
    model_assessment = None

    try:
        config_path = repo / args.config if args.config else None
        config = load_config(config_path)
        max_depth = args.max_lineage_depth or config.settings.max_lineage_depth
        target = args.target or os.environ.get("DATABRICKS_BUNDLE_TARGET")
        changes = collect_changes(
            repo,
            args.base,
            args.head,
            target=target,
            bundle_file=args.bundle_file,
        )

        if not changes.complete:
            limitations = [
                f"{issue.revision}:{issue.source}:{issue.code}:{issue.path or ''}"
                for issue in changes.issues
            ]
            result = GuardResult(
                status="error",
                summary="Static bundle or SQL discovery was incomplete.",
                assessment_complete=False,
                discovery_certainty=DiscoveryCertainty.INCOMPLETE,
                changed_files=changes.changed_files,
                semantic_changes=_semantic_change_evidence(changes),
                bundle_changes=[_bundle_change_evidence(changes)],
                coverage_limitations=limitations,
                error="unresolved discovery prevents a complete assessment",
            )
        elif not changes.has_relevant_changes:
            result = GuardResult(
                status="pass",
                summary="No output-producing SQL or bundle change was discovered.",
                changed_files=changes.changed_files,
            )
        elif not changes.affected_datasets:
            result = _error_result(
                "Relevant bundle changes did not resolve to any output dataset",
                changes.changed_files,
            )
            result.bundle_changes = [_bundle_change_evidence(changes)]
        else:
            warehouse_id = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
            endpoint = os.environ.get("DATABRICKS_SERVING_ENDPOINT", "")
            observed = LineageRepository(
                executor=StatementExecutor(warehouse_id=warehouse_id),
                lookback_days=LINEAGE_LOOKBACK_DAYS,
            ).downstream_graph(set(changes.affected_datasets), max_depth=max_depth)
            observed_sources = observed.source_tables(EvidenceOrigin.OBSERVED_LINEAGE)
            missing = sorted(set(changes.affected_datasets) - observed_sources)
            combined = LineageGraph([*changes.proposed_code_edges, *observed.edges])
            if missing:
                result = GuardResult(
                    status="error",
                    summary="Observed lineage coverage was incomplete.",
                    assessment_complete=False,
                    discovery_certainty=DiscoveryCertainty.INCOMPLETE,
                    changed_files=changes.changed_files,
                    semantic_changes=_semantic_change_evidence(changes),
                    bundle_changes=[_bundle_change_evidence(changes)],
                    lineage_edges=combined.edges,
                    coverage_limitations=[
                        "No recent observed downstream lineage for " + dataset
                        for dataset in missing
                    ],
                    error="missing observed lineage prevents a complete assessment",
                )
            else:
                context = _assessment_context(changes, observed, combined, max_depth)
                model_assessment = AIGatewayAssessor(endpoint=endpoint).assess(context)
                result = evaluate_assessment(
                    assessment=model_assessment,
                    graph=combined,
                    changed_tables=set(changes.affected_datasets),
                    changed_files=changes.changed_files,
                    block_confidence=BLOCK_CONFIDENCE,
                    semantic_changes=_semantic_change_evidence(changes),
                    bundle_changes=[_bundle_change_evidence(changes)],
                )
    except Exception as exc:
        result = _error_result(str(exc), changes.changed_files if changes else [])

    evidence = _restricted_payload(result, changes, model_assessment=model_assessment)
    source = AssessmentSource(
        repository=args.repository,
        pull_request_number=args.pull_request_number,
        base_sha=(changes.base_sha if changes is not None else args.base),
        head_sha=(changes.head_sha if changes is not None else args.head),
    )
    return _publish(
        result,
        evidence,
        source=source,
        output=output,
        markdown_output=markdown_output,
        restricted_dir=restricted_dir,
    )


def _workspace_files() -> Any:
    from databricks.sdk import WorkspaceClient

    return WorkspaceClient().files


def publish_evidence(args: argparse.Namespace) -> int:
    """Publish a locally staged envelope to its immutable UC Volume path."""

    public_path = Path(args.public_assessment).resolve()
    restricted_dir = Path(args.restricted_evidence_dir).resolve()
    reference = reference_from_public_artifact(public_path.read_bytes())
    result = publish_restricted_evidence(
        store=RestrictedEvidenceStore(restricted_dir),
        reference=reference,
        volume_root=args.volume_root,
        files=_workspace_files(),
    )
    write_private_publication_receipt(result, Path(args.receipt_output))
    disposition = "created" if result.created else "already_present"
    print(
        "lineage-guard restricted_evidence="
        f"{disposition} assessment_reference={result.reference.value}"
    )
    return 0


def render_public(args: argparse.Namespace) -> int:
    """Re-render a validated public artifact with its authorized app link."""

    disclosure = deserialize_public_artifact(Path(args.input).read_bytes())
    validate_publication_receipt(
        Path(args.publication_receipt).read_bytes(),
        reference=disclosure.reference,
        volume_root=args.volume_root,
    )
    markdown = render_public_markdown(
        disclosure,
        assessment_base_url=args.assessment_base_url,
    )
    Path(args.markdown_output).write_text(markdown, encoding="utf-8")
    return 0


def discover(args: argparse.Namespace) -> int:
    try:
        endpoint, failures = discover_endpoint(args.profile)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if failures:
        for failure in failures:
            print(f"Skipped {failure}", file=sys.stderr)
    print(endpoint)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lineage-guard")
    subparsers = parser.add_subparsers(dest="command", required=True)

    assess_parser = subparsers.add_parser("assess", help="Assess a Git commit range")
    assess_parser.add_argument("--base", required=True, help="Base Git commit or ref")
    assess_parser.add_argument("--head", required=True, help="Head Git commit or ref")
    assess_parser.add_argument(
        "--repository",
        default=os.environ.get("GITHUB_REPOSITORY"),
        required=os.environ.get("GITHUB_REPOSITORY") is None,
        help="GitHub repository in owner/name form",
    )
    assess_parser.add_argument(
        "--pull-request-number",
        required=True,
        type=int,
        help="GitHub pull request number",
    )
    assess_parser.add_argument("--repo", default=".", help="Repository root")
    assess_parser.add_argument("--bundle-file", default="databricks.yml")
    assess_parser.add_argument("--target")
    assess_parser.add_argument("--config", default="lineage_guard.yml")
    assess_parser.add_argument("--max-lineage-depth", type=int, choices=range(1, 21))
    assess_parser.add_argument("--output", default="assessment.json")
    assess_parser.add_argument("--markdown-output", default="assessment.md")
    assess_parser.add_argument("--restricted-evidence-dir")
    assess_parser.set_defaults(handler=assess)

    publish_parser = subparsers.add_parser(
        "publish-evidence",
        help="Publish an immutable restricted envelope to a Unity Catalog Volume",
    )
    publish_parser.add_argument("--public-assessment", default="assessment.json")
    publish_parser.add_argument(
        "--restricted-evidence-dir",
        default=os.environ.get("LINEAGE_GUARD_RESTRICTED_DIR"),
        required=os.environ.get("LINEAGE_GUARD_RESTRICTED_DIR") is None,
    )
    publish_parser.add_argument("--receipt-output", required=True)
    publish_parser.add_argument(
        "--volume-root",
        default=os.environ.get(
            "LINEAGE_GUARD_RESTRICTED_VOLUME_ROOT",
            DEFAULT_RESTRICTED_VOLUME_ROOT,
        ),
    )
    publish_parser.set_defaults(handler=publish_evidence)

    render_parser = subparsers.add_parser(
        "render-public",
        help="Render validated public Markdown with an assessment app link",
    )
    render_parser.add_argument("--input", default="assessment.json")
    render_parser.add_argument("--markdown-output", default="assessment.md")
    render_parser.add_argument("--assessment-base-url", required=True)
    render_parser.add_argument("--publication-receipt", required=True)
    render_parser.add_argument(
        "--volume-root",
        default=os.environ.get(
            "LINEAGE_GUARD_RESTRICTED_VOLUME_ROOT",
            DEFAULT_RESTRICTED_VOLUME_ROOT,
        ),
    )
    render_parser.set_defaults(handler=render_public)

    discover_parser = subparsers.add_parser(
        "discover-endpoint", help="Select a compatible Claude Sonnet endpoint"
    )
    discover_parser.add_argument("--profile", required=True)
    discover_parser.set_defaults(handler=discover)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.handler(args))
