from lineage_guard.evaluate import evaluate_assessment
from lineage_guard.lineage import LineageGraph
from lineage_guard.models import (
    Decision,
    EvidenceOrigin,
    Impact,
    LineageEdge,
    ModelAssessment,
    Severity,
)

SOURCE = "proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts"
SILVER = "proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure"
GOLD = "proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss"


def graph() -> LineageGraph:
    return LineageGraph(
        [
            LineageEdge(
                source_table=SOURCE,
                source_column="outstanding_balance",
                target_table=SILVER,
                target_column="effective_ead",
                level="column",
            ),
            LineageEdge(source_table=SILVER, target_table=GOLD, level="column"),
        ]
    )


def assessment(*, confidence: float = 0.95, asset: str = GOLD) -> ModelAssessment:
    return ModelAssessment(
        decision=Decision.BLOCK,
        severity=Severity.HIGH,
        confidence=confidence,
        summary="A numeric balance became formatted text.",
        impacts=[
            Impact(
                asset=asset,
                path=[SOURCE, SILVER, asset],
                failure_mode="Arithmetic type incompatibility",
                evidence="effective_ead adds outstanding_balance to a decimal expression",
            )
        ],
    )


def test_high_confidence_grounded_impact_blocks() -> None:
    result = evaluate_assessment(assessment(), graph(), {SOURCE}, ["loan_accounts.sql"], 0.8)
    assert result.status == "block"
    assert result.exit_code == 1
    assert len(result.impacts) == 1


def test_below_threshold_warns() -> None:
    result = evaluate_assessment(
        assessment(confidence=0.79), graph(), {SOURCE}, ["loan_accounts.sql"], 0.8
    )
    assert result.status == "warn"
    assert result.exit_code == 0


def test_safe_governed_change_passes() -> None:
    safe = ModelAssessment(
        decision=Decision.PASS,
        severity=Severity.LOW,
        confidence=0.98,
        summary="Only a descriptive comment changed.",
        impacts=[],
    )
    result = evaluate_assessment(safe, graph(), {SOURCE}, ["loan_accounts.sql"], 0.8)
    assert result.status == "pass"
    assert result.exit_code == 0


def test_hallucinated_path_cannot_block() -> None:
    fake_asset = "proactive_zero_ops_catalog.proactive_zero_ops_gold.nonexistent"
    result = evaluate_assessment(
        assessment(asset=fake_asset), graph(), {SOURCE}, ["loan_accounts.sql"], 0.8
    )
    assert result.status == "warn"
    assert not result.impacts
    assert any("Rejected ungrounded" in warning for warning in result.warnings)


def test_proposed_code_path_is_distinguished_and_can_ground_an_impact() -> None:
    code_graph = LineageGraph(
        [
            LineageEdge(
                source_table=SOURCE,
                target_table=SILVER,
                level="table",
                origin=EvidenceOrigin.PROPOSED_CODE,
            ),
            LineageEdge(
                source_table=SILVER,
                target_table=GOLD,
                level="table",
                origin=EvidenceOrigin.PROPOSED_CODE,
            ),
        ]
    )
    result = evaluate_assessment(assessment(), code_graph, {SOURCE}, ["loan_accounts.sql"], 0.8)
    assert result.status == "block"
    assert code_graph.path_evidence([SOURCE, SILVER, GOLD])[0]["origins"] == ["proposed_code"]


def test_incomplete_discovery_cannot_be_overridden_by_model_confidence() -> None:
    result = evaluate_assessment(
        assessment(),
        graph(),
        {SOURCE},
        ["loan_accounts.sql"],
        0.8,
        discovery_complete=False,
        coverage_limitations=["unsupported Lakeflow syntax"],
    )
    assert result.status == "error"
    assert result.exit_code == 2
    assert result.discovery_certainty.value == "incomplete"
