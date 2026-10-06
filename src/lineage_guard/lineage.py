from __future__ import annotations

import re
import time
from collections import defaultdict
from collections.abc import Iterable
from functools import cached_property
from typing import Any

from lineage_guard.models import EvidenceOrigin, LineageEdge

FQN_PATTERN = re.compile(r"^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$")


class LineageQueryError(RuntimeError):
    pass


def _enum_value(value: Any) -> str:
    return str(getattr(value, "value", value)).upper()


class StatementExecutor:
    def __init__(self, warehouse_id: str, workspace_client: Any | None = None) -> None:
        if not warehouse_id:
            raise ValueError("DATABRICKS_WAREHOUSE_ID is required")
        if workspace_client is None:
            from databricks.sdk import WorkspaceClient

            workspace_client = WorkspaceClient()
        self.warehouse_id = warehouse_id
        self.workspace_client = workspace_client

    @cached_property
    def workspace_id(self) -> int:
        """Use the identity of the same authenticated client that executes lineage SQL."""
        workspace_id = self.workspace_client.get_workspace_id()
        if (
            isinstance(workspace_id, bool)
            or not isinstance(workspace_id, int)
            or not 0 < workspace_id <= 2**63 - 1
        ):
            raise LineageQueryError("authenticated workspace ID must be a positive BIGINT")
        return workspace_id

    def query(self, statement: str, timeout_seconds: int = 120) -> list[list[Any]]:
        for attempt in range(3):
            try:
                return self._query_once(statement, timeout_seconds)
            except Exception as exc:
                if attempt == 2 or not _retryable_lineage_error(exc):
                    raise
                time.sleep(2**attempt)
        raise AssertionError("unreachable")

    def _query_once(self, statement: str, timeout_seconds: int) -> list[list[Any]]:
        response = self.workspace_client.statement_execution.execute_statement(
            warehouse_id=self.warehouse_id,
            statement=statement,
            wait_timeout="30s",
        )
        deadline = time.monotonic() + timeout_seconds
        while _enum_value(response.status.state) in {"PENDING", "RUNNING"}:
            if time.monotonic() >= deadline:
                raise LineageQueryError("SQL statement timed out while reading lineage")
            time.sleep(2)
            response = self.workspace_client.statement_execution.get_statement(
                response.statement_id
            )

        state = _enum_value(response.status.state)
        if state != "SUCCEEDED":
            error = getattr(response.status, "error", None)
            message = getattr(error, "message", None) or f"statement finished in state {state}"
            raise LineageQueryError(message)

        result = getattr(response, "result", None)
        return list(getattr(result, "data_array", None) or [])


def _retryable_lineage_error(error: Exception) -> bool:
    status = getattr(error, "status_code", None)
    return status in {408, 429, 500, 502, 503, 504} or "unexpected condition" in str(error).lower()


class LineageGraph:
    def __init__(self, edges: Iterable[LineageEdge] = ()) -> None:
        deduplicated: dict[tuple[str, str, str | None, str | None, str, str], LineageEdge] = {}
        for original in edges:
            edge = original.model_copy(
                update={
                    "source_table": original.source_table.lower(),
                    "target_table": original.target_table.lower(),
                }
            )
            deduplicated[edge.key] = edge
        self.edges = list(deduplicated.values())
        self._adjacency: dict[str, set[str]] = defaultdict(set)
        for edge in self.edges:
            self._adjacency[edge.source_table].add(edge.target_table)

    def has_path(self, path: list[str]) -> bool:
        normalized = [part.lower() for part in path]
        if len(normalized) < 2:
            return False
        return all(
            target in self._adjacency.get(source, set())
            for source, target in zip(normalized, normalized[1:], strict=False)
        )

    def downstream_tables(self) -> set[str]:
        return {edge.target_table for edge in self.edges}

    def source_tables(self, origin: EvidenceOrigin | None = None) -> set[str]:
        if origin is None:
            return set(self._adjacency)
        return {edge.source_table for edge in self.edges if edge.origin == origin}

    def edge_origins(self, source: str, target: str) -> set[EvidenceOrigin]:
        source = source.lower()
        target = target.lower()
        return {
            edge.origin
            for edge in self.edges
            if edge.source_table == source and edge.target_table == target
        }

    def path_evidence(self, path: list[str]) -> list[dict[str, object]]:
        normalized = [part.lower() for part in path]
        if not self.has_path(normalized):
            return []
        return [
            {
                "source": source,
                "target": target,
                "origins": sorted(origin.value for origin in self.edge_origins(source, target)),
            }
            for source, target in zip(normalized, normalized[1:], strict=False)
        ]

    def paths_from(self, sources: Iterable[str], max_depth: int) -> list[list[str]]:
        paths: set[tuple[str, ...]] = set()
        frontier = [(source.lower(),) for source in sorted(set(sources))]
        while frontier:
            path = frontier.pop(0)
            if len(path) - 1 >= max_depth:
                continue
            for target in sorted(self._adjacency.get(path[-1], set())):
                if target in path:
                    continue
                next_path = (*path, target)
                paths.add(next_path)
                frontier.append(next_path)
        return [list(path) for path in sorted(paths)]


class LineageRepository:
    def __init__(self, executor: StatementExecutor, lookback_days: int = 30) -> None:
        if not 1 <= lookback_days <= 365:
            raise ValueError("lineage lookback must be between 1 and 365 days")
        self.executor = executor
        self.lookback_days = lookback_days
        self.workspace_id = executor.workspace_id

    @staticmethod
    def _table_list(tables: Iterable[str]) -> str:
        normalized = sorted({table.lower() for table in tables})
        if not normalized or any(not FQN_PATTERN.fullmatch(table) for table in normalized):
            raise ValueError("lineage queries require validated three-part table names")
        return ", ".join(f"'{table}'" for table in normalized)

    def _column_edges(self, tables: set[str]) -> list[LineageEdge]:
        table_list = self._table_list(tables)
        rows = self.executor.query(
            f"""
SELECT
  lower(source_table_full_name),
  lower(source_column_name),
  lower(target_table_full_name),
  lower(target_column_name),
  entity_type,
  CAST(entity_id AS STRING),
  CAST(entity_run_id AS STRING),
  created_by,
  CAST(MAX(event_time) AS STRING)
FROM system.access.column_lineage
WHERE event_date >= dateadd(DAY, -{self.lookback_days}, current_date())
  AND workspace_id = {self.workspace_id}
  AND lower(source_table_full_name) IN ({table_list})
  AND target_table_full_name IS NOT NULL
GROUP BY ALL
""".strip()
        )
        return [
            LineageEdge(
                source_table=row[0],
                source_column=row[1],
                target_table=row[2],
                target_column=row[3],
                level="column",
                entity_type=row[4] if len(row) >= 9 else None,
                entity_id=row[5] if len(row) >= 9 else None,
                entity_run_id=row[6] if len(row) >= 9 else None,
                created_by=row[7] if len(row) >= 9 else None,
                event_time=row[8] if len(row) >= 9 else row[4],
                origin=EvidenceOrigin.OBSERVED_LINEAGE,
            )
            for row in rows
            if row[0] and row[2]
        ]

    def _table_edges(self, tables: set[str]) -> list[LineageEdge]:
        table_list = self._table_list(tables)
        rows = self.executor.query(
            f"""
SELECT
  lower(source_table_full_name),
  COALESCE(
    lower(target_table_full_name),
    CASE
      WHEN entity_type IS NOT NULL AND COALESCE(entity_id, entity_run_id) IS NOT NULL
      THEN concat(
        'databricks://',
        lower(entity_type),
        '/',
        CAST(COALESCE(entity_id, entity_run_id) AS STRING)
      )
    END
  ),
  COALESCE(target_type, entity_type, 'ENTITY'),
  entity_type,
  CAST(entity_id AS STRING),
  CAST(entity_run_id AS STRING),
  created_by,
  CAST(MAX(event_time) AS STRING)
FROM system.access.table_lineage
WHERE event_date >= dateadd(DAY, -{self.lookback_days}, current_date())
  AND workspace_id = {self.workspace_id}
  AND lower(source_table_full_name) IN ({table_list})
  AND (
    target_table_full_name IS NOT NULL
    OR (entity_type IS NOT NULL AND COALESCE(entity_id, entity_run_id) IS NOT NULL)
  )
GROUP BY ALL
""".strip()
        )
        return [
            LineageEdge(
                source_table=row[0],
                target_table=row[1],
                target_type=row[2] or "TABLE",
                level="table",
                entity_type=row[3] if len(row) >= 8 else None,
                entity_id=row[4] if len(row) >= 8 else None,
                entity_run_id=row[5] if len(row) >= 8 else None,
                created_by=row[6] if len(row) >= 8 else None,
                event_time=row[7] if len(row) >= 8 else row[3],
                origin=EvidenceOrigin.OBSERVED_LINEAGE,
            )
            for row in rows
            if row[0] and row[1]
        ]

    def downstream_graph(self, sources: set[str], max_depth: int = 5) -> LineageGraph:
        if not 1 <= max_depth <= 20:
            raise ValueError("max lineage depth must be between 1 and 20")
        frontier = {source.lower() for source in sources}
        visited: set[str] = set()
        collected: list[LineageEdge] = []

        for _ in range(max_depth):
            frontier -= visited
            if not frontier:
                break
            visited |= frontier
            level_edges = self._column_edges(frontier) + self._table_edges(frontier)
            collected.extend(level_edges)
            frontier = {
                edge.target_table
                for edge in level_edges
                if FQN_PATTERN.fullmatch(edge.target_table) and edge.target_table not in visited
            }

        return LineageGraph(collected)
