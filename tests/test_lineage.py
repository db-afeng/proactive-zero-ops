from lineage_guard.lineage import LineageGraph, LineageRepository
from lineage_guard.models import EvidenceOrigin, LineageEdge


def edge(source: str, target: str, level: str = "table") -> LineageEdge:
    return LineageEdge(source_table=source, target_table=target, level=level)


def test_graph_validates_every_hop() -> None:
    graph = LineageGraph(
        [
            edge("main.bronze.accounts", "main.silver.exposure"),
            edge("main.silver.exposure", "main.gold.expected_loss"),
        ]
    )
    assert graph.has_path(
        ["main.bronze.accounts", "main.silver.exposure", "main.gold.expected_loss"]
    )
    assert not graph.has_path(["main.bronze.accounts", "main.gold.expected_loss"])


def test_graph_deduplicates_edges_and_enumerates_verified_paths() -> None:
    first = edge("main.bronze.accounts", "main.silver.exposure")
    graph = LineageGraph(
        [
            first,
            first,
            edge("main.silver.exposure", "main.gold.expected_loss"),
        ]
    )
    assert len(graph.edges) == 2
    assert graph.source_tables() == {"main.bronze.accounts", "main.silver.exposure"}
    assert graph.paths_from({"main.bronze.accounts"}, max_depth=5) == [
        ["main.bronze.accounts", "main.silver.exposure"],
        ["main.bronze.accounts", "main.silver.exposure", "main.gold.expected_loss"],
    ]


def test_code_and_observed_dependency_evidence_remain_distinct() -> None:
    observed = edge("main.bronze.accounts", "main.silver.exposure")
    proposed = observed.model_copy(update={"origin": EvidenceOrigin.PROPOSED_CODE})
    graph = LineageGraph([observed, proposed])

    assert len(graph.edges) == 2
    assert graph.path_evidence([observed.source_table, observed.target_table])[0]["origins"] == [
        "observed_lineage",
        "proposed_code",
    ]


class FakeExecutor:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def query(self, statement: str) -> list[list[str | None]]:
        self.calls.append(statement)
        if "column_lineage" in statement and "main.bronze.accounts" in statement:
            return [
                [
                    "main.bronze.accounts",
                    "balance",
                    "main.silver.exposure",
                    "ead",
                    "2026-09-24 00:00:00",
                ]
            ]
        if "table_lineage" in statement and "main.silver.exposure" in statement:
            return [
                [
                    "main.silver.exposure",
                    "main.gold.expected_loss",
                    "MATERIALIZED_VIEW",
                    "2026-09-24 00:00:00",
                ]
            ]
        return []


def test_repository_walks_breadth_first() -> None:
    executor = FakeExecutor()
    repository = LineageRepository(executor=executor, lookback_days=30)  # type: ignore[arg-type]
    graph = repository.downstream_graph({"main.bronze.accounts"}, max_depth=5)
    assert graph.has_path(
        ["main.bronze.accounts", "main.silver.exposure", "main.gold.expected_loss"]
    )
    assert any("event_date >=" in call for call in executor.calls)
    assert len(graph.edges) == 2


class EntityExecutor:
    def query(self, statement: str) -> list[list[str | None]]:
        if "table_lineage" in statement:
            return [
                [
                    "main.gold.expected_loss",
                    "databricks://dashboard/abc-123",
                    "DASHBOARD",
                    "DASHBOARD",
                    "abc-123",
                    "run-1",
                    "owner@example.com",
                    "2026-09-28 00:00:00",
                ]
            ]
        return []


def test_repository_includes_external_entity_consumers_without_traversing_them() -> None:
    repository = LineageRepository(executor=EntityExecutor(), lookback_days=30)  # type: ignore[arg-type]
    graph = repository.downstream_graph({"main.gold.expected_loss"}, max_depth=5)

    edge = graph.edges[0]
    assert edge.target_table == "databricks://dashboard/abc-123"
    assert edge.entity_id == "abc-123"
    assert edge.created_by == "owner@example.com"
