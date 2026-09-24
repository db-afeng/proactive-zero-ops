from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from lineage_guard.ai import AIGatewayAssessor, discover_endpoint
from lineage_guard.config import GuardConfig, load_config
from lineage_guard.evaluate import evaluate_assessment
from lineage_guard.gitdiff import collect_changes, read_file_at_commit
from lineage_guard.lineage import LineageRepository, StatementExecutor
from lineage_guard.models import GuardResult, Severity
from lineage_guard.report import render_markdown


def _write_result(result: GuardResult, output: Path, markdown_output: Path) -> None:
    output.write_text(result.model_dump_json(indent=2) + "\n", encoding="utf-8")
    markdown_output.write_text(render_markdown(result), encoding="utf-8")


def _context(
    config: GuardConfig,
    repo: Path,
    changes: Any,
    graph: Any,
) -> dict[str, Any]:
    downstream_sql: dict[str, dict[str, str]] = {}
    for table in sorted(graph.downstream_tables()):
        path = config.tables_to_paths.get(table)
        if path:
            downstream_sql[table] = {
                "path": path,
                "sql": read_file_at_commit(repo, changes.head_sha, path),
            }

    context = {
        "changed_datasets": [
            {
                "path": dataset.path,
                "table": dataset.table,
                "diff": dataset.diff,
                "base_sql": dataset.base_sql,
                "head_sql": dataset.head_sql,
            }
            for dataset in changes.datasets
        ],
        "lineage_edges": [edge.model_dump(mode="json") for edge in graph.edges],
        "verified_lineage_paths": graph.paths_from(
            {dataset.table for dataset in changes.datasets},
            config.settings.max_lineage_depth,
        ),
        "downstream_definitions": downstream_sql,
        "assessment_rules": {
            "block_severities": ["high", "critical"],
            "block_confidence": config.settings.block_confidence,
            "require_observed_lineage_path": True,
        },
    }
    serialized = json.dumps(context, sort_keys=True)
    if len(serialized) > config.settings.max_context_characters:
        raise RuntimeError(
            f"assessment context is {len(serialized)} characters, exceeding the configured "
            f"limit of {config.settings.max_context_characters}; split the pull request"
        )
    return context


def assess(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    output = Path(args.output).resolve()
    markdown_output = Path(args.markdown_output).resolve()
    changed_files: list[str] = []
    try:
        config = load_config((repo / args.config).resolve())
        changes = collect_changes(repo, config, args.base, args.head)
        changed_files = changes.changed_files
        if not changes.datasets:
            result = GuardResult(
                status="pass",
                summary="No governed credit-risk transformation changed.",
                changed_files=changed_files,
            )
            _write_result(result, output, markdown_output)
            return result.exit_code

        warehouse_id = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
        endpoint = os.environ.get("DATABRICKS_SERVING_ENDPOINT", "")
        executor = StatementExecutor(warehouse_id=warehouse_id)
        lineage = LineageRepository(
            executor=executor,
            lookback_days=config.settings.lineage_lookback_days,
        )
        changed_tables = {dataset.table for dataset in changes.datasets}
        graph = lineage.downstream_graph(
            changed_tables,
            max_depth=config.settings.max_lineage_depth,
        )
        missing_lineage = sorted(changed_tables - graph.source_tables())
        if missing_lineage:
            raise RuntimeError(
                "no recent downstream lineage was found for changed governed datasets: "
                + ", ".join(missing_lineage)
            )

        context = _context(config, repo, changes, graph)
        model_assessment = AIGatewayAssessor(endpoint=endpoint).assess(context)
        result = evaluate_assessment(
            assessment=model_assessment,
            graph=graph,
            changed_tables=changed_tables,
            changed_files=changed_files,
            block_confidence=config.settings.block_confidence,
        )
    except Exception as exc:
        result = GuardResult(
            status="error",
            severity=Severity.NONE,
            summary="The downstream impact assessment could not be completed safely.",
            changed_files=changed_files,
            error=str(exc),
        )

    _write_result(result, output, markdown_output)
    return result.exit_code


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
    assess_parser.add_argument("--repo", default=".", help="Repository root")
    assess_parser.add_argument("--config", default="lineage_guard.yml")
    assess_parser.add_argument("--output", default="assessment.json")
    assess_parser.add_argument("--markdown-output", default="assessment.md")
    assess_parser.set_defaults(handler=assess)

    discover_parser = subparsers.add_parser(
        "discover-endpoint", help="Select a compatible Claude Sonnet endpoint"
    )
    discover_parser.add_argument("--profile", required=True)
    discover_parser.set_defaults(handler=discover)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.handler(args))
