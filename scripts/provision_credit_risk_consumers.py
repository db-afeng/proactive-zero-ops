"""Provision and exercise the saved SQL queries used by the lineage impact demo.

Dashboards and Genie spaces are deployed through the root asset bundle. Saved queries
are provisioned through the Queries API because bundle SQL tasks need their stable IDs.
This script creates one unscheduled Job with a SQL task for each saved query, and can
run the Job to produce lineage with a populated sql_query_id.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from databricks.sdk import WorkspaceClient
from databricks.sdk.service import jobs, sql

ROOT = Path(__file__).resolve().parents[1]
QUERY_DIR = ROOT / "src/credit_risk/consumers/queries"
QUERY_TAG = "pzo-demo-lineage-consumer"
JOB_NAME = "PZO Demo | Saved Query Lineage Seed"
JOB_TAGS = {"project": "proactive-zero-ops", "purpose": "lineage-consumer-demo"}
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")


@dataclass(frozen=True)
class QuerySpec:
    key: str
    title: str
    schema_kind: str
    source_table: str


QUERIES = (
    QuerySpec("exposure_by_product", "Exposure by Product", "silver", "loan_exposure"),
    QuerySpec("exposure_by_region", "Exposure by Region", "silver", "loan_exposure"),
    QuerySpec("exposure_by_risk_grade", "Exposure by Risk Grade", "silver", "loan_exposure"),
    QuerySpec("high_utilization_accounts", "High Utilization Accounts", "silver", "loan_exposure"),
    QuerySpec(
        "expected_loss_by_region", "Expected Loss by Region", "gold", "portfolio_expected_loss"
    ),
    QuerySpec(
        "expected_loss_by_risk_grade",
        "Expected Loss by Risk Grade",
        "gold",
        "portfolio_expected_loss",
    ),
    QuerySpec(
        "sector_concentration_ranking",
        "Sector Concentration Ranking",
        "gold",
        "sector_concentration",
    ),
)


def _identifier(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise ValueError(f"Invalid Unity Catalog identifier: {value!r}")
    return value


def _query_name(spec: QuerySpec) -> str:
    return f"PZO Demo | Query | {spec.title}"


def _schema(spec: QuerySpec, args: argparse.Namespace) -> str:
    return args.silver_schema if spec.schema_kind == "silver" else args.gold_schema


def _source(spec: QuerySpec, args: argparse.Namespace) -> str:
    return f"{args.catalog}.{_schema(spec, args)}.{spec.source_table}".lower()


def _render_sql(spec: QuerySpec, args: argparse.Namespace) -> str:
    statement = (QUERY_DIR / f"{spec.key}.sql").read_text(encoding="utf-8")
    for key, value in {
        "catalog": args.catalog,
        "silver_schema": args.silver_schema,
        "gold_schema": args.gold_schema,
    }.items():
        statement = statement.replace("${" + key + "}", value)
    if "${" in statement:
        raise ValueError(f"Unresolved substitution in {spec.key}.sql")
    return statement.strip()


def _description(spec: QuerySpec, args: argparse.Namespace) -> str:
    return (
        "Proactive Zero Ops synthetic credit-risk consumer. "
        f"Reads {_source(spec, args)}. "
        f"Managed by scripts/provision_credit_risk_consumers.py ({QUERY_TAG})."
    )


def _matching_query(queries: list, spec: QuerySpec):
    matches = [item for item in queries if item.display_name == _query_name(spec)]
    if len(matches) > 1:
        raise RuntimeError(
            f"Multiple saved queries named {_query_name(spec)!r}; resolve them first"
        )
    if matches and QUERY_TAG not in (matches[0].tags or []):
        raise RuntimeError(
            f"Saved query {_query_name(spec)!r} exists without the {QUERY_TAG!r} tag; "
            "refusing to change an unmanaged query"
        )
    return matches[0] if matches else None


def _provision_queries(client: WorkspaceClient, args: argparse.Namespace) -> dict[str, str]:
    existing = list(client.queries.list())
    query_ids: dict[str, str] = {}
    for spec in QUERIES:
        name = _query_name(spec)
        schema = _schema(spec, args)
        statement = _render_sql(spec, args)
        description = _description(spec, args)
        current = _matching_query(existing, spec)
        if current is None:
            created = client.queries.create(
                query=sql.CreateQueryRequestQuery(
                    display_name=name,
                    description=description,
                    query_text=statement,
                    warehouse_id=args.warehouse_id,
                    catalog=args.catalog,
                    schema=schema,
                    tags=[QUERY_TAG],
                    apply_auto_limit=False,
                )
            )
            query_id = created.id
            action = "created"
        else:
            query_id = current.id
            full = client.queries.get(query_id)
            wanted = {
                "description": description,
                "query_text": statement,
                "warehouse_id": args.warehouse_id,
                "catalog": args.catalog,
                "schema": schema,
                "tags": [QUERY_TAG],
                "apply_auto_limit": False,
            }
            changed = [key for key, value in wanted.items() if getattr(full, key) != value]
            if changed:
                client.queries.update(
                    query_id,
                    ",".join(changed),
                    query=sql.UpdateQueryRequestQuery(**{key: wanted[key] for key in changed}),
                )
                action = "updated"
            else:
                action = "reused"
        if not query_id:
            raise RuntimeError(f"Queries API returned no ID for {name}")
        query_ids[spec.key] = query_id
        print(f"{action}: {name} ({query_id})", flush=True)
    return query_ids


def _find_queries(client: WorkspaceClient) -> dict[str, str]:
    existing = list(client.queries.list())
    found: dict[str, str] = {}
    for spec in QUERIES:
        current = _matching_query(existing, spec)
        if current is None or not current.id:
            raise RuntimeError(f"Saved query missing: {_query_name(spec)}")
        found[spec.key] = current.id
    return found


def _job_settings(query_ids: dict[str, str], warehouse_id: str) -> jobs.JobSettings:
    return jobs.JobSettings(
        name=JOB_NAME,
        description="Run the seven saved demo queries so their query IDs appear in system lineage.",
        tags=JOB_TAGS,
        max_concurrent_runs=1,
        tasks=[
            jobs.Task(
                task_key=spec.key,
                sql_task=jobs.SqlTask(
                    warehouse_id=warehouse_id,
                    query=jobs.SqlTaskQuery(query_id=query_ids[spec.key]),
                ),
            )
            for spec in QUERIES
        ],
    )


def _task_refs(settings: jobs.JobSettings | None) -> list[tuple[str, str, str]]:
    if settings is None:
        return []
    return sorted(
        (
            task.task_key,
            task.sql_task.query.query_id,
            task.sql_task.warehouse_id,
        )
        for task in settings.tasks or []
        if task.sql_task is not None and task.sql_task.query is not None
    )


def _provision_job(client: WorkspaceClient, query_ids: dict[str, str], warehouse_id: str) -> int:
    settings = _job_settings(query_ids, warehouse_id)
    matches = [
        item
        for item in client.jobs.list(name=JOB_NAME)
        if item.settings is not None and item.settings.name == JOB_NAME
    ]
    if len(matches) > 1:
        raise RuntimeError(f"Multiple Jobs named {JOB_NAME!r}; resolve them first")
    if matches:
        current = client.jobs.get(matches[0].job_id)
        if not current.settings or current.settings.tags != JOB_TAGS:
            raise RuntimeError(f"Job {JOB_NAME!r} exists without the expected tags")
        if _task_refs(current.settings) != _task_refs(settings):
            client.jobs.reset(current.job_id, settings)
            action = "updated"
        else:
            action = "reused"
        job_id = current.job_id
    else:
        job_id = client.jobs.create(
            name=settings.name,
            description=settings.description,
            tags=settings.tags,
            max_concurrent_runs=settings.max_concurrent_runs,
            tasks=settings.tasks,
        ).job_id
        action = "created"
    if job_id is None:
        raise RuntimeError("Jobs API returned no ID")
    print(f"{action}: {JOB_NAME} ({job_id}); no schedule", flush=True)
    return job_id


def _lineage_rows(client: WorkspaceClient, args: argparse.Namespace, query_ids: dict[str, str]):
    quoted_ids = ", ".join("'" + item.replace("'", "''") + "'" for item in query_ids.values())
    sources = sorted({_source(spec, args) for spec in QUERIES})
    quoted_sources = ", ".join("'" + item + "'" for item in sources)
    statement = f"""
SELECT lower(source_table_full_name) AS source_table,
       entity_metadata.sql_query_id AS query_id,
       COUNT(*) AS lineage_rows,
       MAX(event_time) AS latest_event_time
FROM system.access.table_lineage
WHERE event_date >= date_sub(current_date(), {args.lineage_days})
  AND lower(source_table_full_name) IN ({quoted_sources})
  AND entity_metadata.sql_query_id IN ({quoted_ids})
GROUP BY 1, 2
""".strip()
    response = client.statement_execution.execute_statement(
        statement=statement,
        warehouse_id=args.warehouse_id,
        wait_timeout="50s",
        row_limit=100,
    )
    while response.status and response.status.state in {
        sql.StatementState.PENDING,
        sql.StatementState.RUNNING,
    }:
        time.sleep(5)
        response = client.statement_execution.get_statement(response.statement_id)
    if not response.status or response.status.state != sql.StatementState.SUCCEEDED:
        error = response.status.error if response.status else None
        raise RuntimeError(f"Lineage verification query failed: {error}")
    return response.result.data_array if response.result and response.result.data_array else []


def _verify_lineage(client: WorkspaceClient, args: argparse.Namespace, query_ids: dict[str, str]):
    expected = {_source(spec, args): set() for spec in QUERIES}
    for spec in QUERIES:
        expected[_source(spec, args)].add(query_ids[spec.key])
    deadline = time.monotonic() + args.lineage_timeout_seconds
    while True:
        rows = _lineage_rows(client, args, query_ids)
        actual: dict[str, set[str]] = {}
        observations: dict[tuple[str, str], tuple[str, str]] = {}
        for source, query_id, count, latest_event_time in rows:
            actual.setdefault(source, set()).add(query_id)
            observations[(source, query_id)] = (count, latest_event_time)
        missing = {
            source: sorted(ids - actual.get(source, set()))
            for source, ids in expected.items()
            if ids - actual.get(source, set())
        }
        if not missing:
            for spec in QUERIES:
                source = _source(spec, args)
                query_id = query_ids[spec.key]
                count, latest_event_time = observations[(source, query_id)]
                print(
                    f"lineage verified: {source} -> {query_id} "
                    f"({count} rows, latest {latest_event_time})",
                    flush=True,
                )
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Saved-query IDs missing from system.access.table_lineage: {missing}"
            )
        print(f"Waiting for system lineage ingestion; missing IDs: {missing}", flush=True)
        time.sleep(min(30, max(1, deadline - time.monotonic())))


def _args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default=os.getenv("DATABRICKS_CONFIG_PROFILE"))
    parser.add_argument("--warehouse-id", default=os.getenv("DATABRICKS_WAREHOUSE_ID"))
    parser.add_argument("--catalog", default="proactive_zero_ops_catalog")
    parser.add_argument("--silver-schema", default="proactive_zero_ops_silver")
    parser.add_argument("--gold-schema", default="proactive_zero_ops_gold")
    parser.add_argument("--lineage-days", type=int, default=7)
    parser.add_argument("--lineage-timeout-seconds", type=int, default=1200)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--run", action="store_true", help="Run the unscheduled Job and verify lineage"
    )
    mode.add_argument(
        "--verify-only", action="store_true", help="Check existing saved-query lineage"
    )
    mode.add_argument("--dry-run", action="store_true", help="Render SQL without API calls")
    args = parser.parse_args(argv)
    if not args.dry_run and not args.warehouse_id:
        parser.error("--warehouse-id or DATABRICKS_WAREHOUSE_ID is required")
    for value in (args.catalog, args.silver_schema, args.gold_schema):
        _identifier(value)
    if args.lineage_days < 1 or args.lineage_timeout_seconds < 0:
        parser.error("lineage days must be positive and timeout must be nonnegative")
    return args


def main(argv: list[str] | None = None) -> int:
    args = _args(sys.argv[1:] if argv is None else argv)
    if args.dry_run:
        for spec in QUERIES:
            print(f"{_query_name(spec)} -> {_source(spec, args)}")
            print(_render_sql(spec, args))
        return 0

    client = WorkspaceClient(profile=args.profile) if args.profile else WorkspaceClient()
    if args.verify_only:
        query_ids = _find_queries(client)
        _verify_lineage(client, args, query_ids)
        return 0

    query_ids = _provision_queries(client, args)
    job_id = _provision_job(client, query_ids, args.warehouse_id)
    if args.run:
        waiter = client.jobs.run_now(job_id)
        print(f"Running saved-query Job {job_id}, run {waiter.response.run_id}", flush=True)
        result = waiter.result(timeout=timedelta(minutes=20))
        if not result.state or result.state.result_state != jobs.RunResultState.SUCCESS:
            raise RuntimeError(f"Saved-query Job did not succeed: {result.state}")
        print("Saved-query Job succeeded; checking system lineage", flush=True)
        _verify_lineage(client, args, query_ids)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
