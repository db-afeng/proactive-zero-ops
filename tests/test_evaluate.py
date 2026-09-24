from lineage_guard.evaluate import evaluate_assessment
from lineage_guard.lineage import LineageGraph
from lineage_guard.models import (
    ChangedColumn,
    Decision,
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
        changed_columns=[
            ChangedColumn(
                table=SOURCE,
                column="outstanding_balance",
                old_contract="DECIMAL(18,2)",
                new_contract="STRING",
                evidence="The changed expression applies currency formatting.",
            )
        ],
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
        changed_columns=[],
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


def test_column_claim_for_unchanged_table_is_rejected() -> None:
    fake = assessment().model_copy(
        update={
            "changed_columns": [
                ChangedColumn(
                    table="proactive_zero_ops_catalog.proactive_zero_ops_bronze.collateral",
                    column="appraised_value",
                    old_contract="DECIMAL",
                    new_contract="STRING",
                    evidence="Not present in the pull request.",
                )
            ]
        }
    )
    result = evaluate_assessment(fake, graph(), {SOURCE}, ["loan_accounts.sql"], 0.8)
    assert result.status == "block"
    assert not result.changed_columns
    assert any("column claim" in warning for warning in result.warnings)


def test_hallucinated_column_on_changed_table_is_rejected() -> None:
    fake = assessment().model_copy(
        update={
            "changed_columns": [
                ChangedColumn(
                    table=SOURCE,
                    column="invented_balance",
                    old_contract="DECIMAL",
                    new_contract="STRING",
                    evidence="Not present in observed column lineage.",
                )
            ]
        }
    )
    result = evaluate_assessment(fake, graph(), {SOURCE}, ["loan_accounts.sql"], 0.8)
    assert result.status == "block"
    assert not result.changed_columns
    assert any("not observed" in warning for warning in result.warnings)
