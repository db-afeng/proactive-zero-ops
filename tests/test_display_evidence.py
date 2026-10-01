from pathlib import Path
from types import SimpleNamespace

from lineage_guard.display_evidence import (
    ImpactReasonCode,
    OperationKind,
    TypeFamily,
    build_display_evidence,
)
from lineage_guard.models import GuardResult, Impact, LineageEdge, Severity
from lineage_guard.sql_analysis import compare_sql_documents, parse_sql_document

ROOT = Path(__file__).parents[1]
TRANSFORMATIONS = ROOT / "src" / "credit_risk" / "transformations"
VARIABLES = {
    "catalog": "proactive_zero_ops_catalog",
    "bronze_schema": "proactive_zero_ops_bronze",
    "silver_schema": "proactive_zero_ops_silver",
    "gold_schema": "proactive_zero_ops_gold",
}
SOURCE = "proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts"
SILVER = "proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure"
GOLD = "proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss"


def fixture_changes() -> SimpleNamespace:
    source_path = TRANSFORMATIONS / "bronze" / "loan_accounts.sql"
    base = source_path.read_text()
    proposed = base.replace(
        "CAST(outstanding_balance_raw AS DECIMAL(18, 2)) AS outstanding_balance",
        "CONCAT('AUD ', FORMAT_NUMBER(CAST(outstanding_balance_raw AS DECIMAL(18, 2)), 2)) "
        "AS outstanding_balance",
    )
    change = compare_sql_documents(
        parse_sql_document(base, path=str(source_path), variables=VARIABLES),
        parse_sql_document(proposed, path=str(source_path), variables=VARIABLES),
    )
    documents = []
    for path in TRANSFORMATIONS.rglob("*.sql"):
        sql = proposed if path == source_path else path.read_text()
        documents.append(
            SimpleNamespace(
                analysis=parse_sql_document(sql, path=str(path), variables=VARIABLES)
            )
        )
    sql_change = SimpleNamespace(
        change=change,
        before_path=str(source_path),
        after_path=str(source_path),
    )
    return SimpleNamespace(
        meaningful_sql_changes=(sql_change,),
        proposed=SimpleNamespace(documents=tuple(documents)),
    )


def fixture_result() -> GuardResult:
    return GuardResult(
        status="block",
        severity=Severity.HIGH,
        confidence=0.95,
        summary="free-form model text",
        impacts=[
            Impact(
                asset=GOLD,
                path=[SOURCE, SILVER, GOLD],
                failure_mode="must remain restricted",
                evidence="must remain restricted",
            )
        ],
        lineage_edges=[
            LineageEdge(
                source_table=SOURCE,
                source_column="outstanding_balance",
                target_table=SILVER,
                target_column="effective_ead",
                level="column",
                event_time="2026-09-24 06:58:44.261",
            ),
            LineageEdge(
                source_table=SILVER,
                target_table=GOLD,
                level="table",
                event_time="2026-09-24T06:58:47.203+00:00",
            ),
            LineageEdge(
                source_table="proactive_zero_ops_catalog.proactive_zero_ops_bronze.payment_events",
                target_table="proactive_zero_ops_catalog.proactive_zero_ops_silver.delinquency_features",
                level="table",
            ),
            LineageEdge(
                source_table="proactive_zero_ops_catalog.proactive_zero_ops_bronze.borrowers",
                target_table="proactive_zero_ops_catalog.proactive_zero_ops_silver.borrower_risk",
                level="table",
            ),
            LineageEdge(
                source_table="proactive_zero_ops_catalog.proactive_zero_ops_bronze.collateral",
                target_table="proactive_zero_ops_catalog.proactive_zero_ops_silver.collateral_coverage",
                level="table",
            ),
        ],
    )


def test_pr4_display_evidence_explains_numeric_contract_break() -> None:
    evidence = build_display_evidence(fixture_result(), fixture_changes())

    change = evidence.changes[0]
    assert change.column == "outstanding_balance"
    assert change.before_type == TypeFamily.NUMERIC
    assert change.after_type == TypeFamily.TEXT
    assert evidence.headline == (
        "outstanding_balance is now text, but loan_exposure still performs numeric arithmetic."
    )

    by_target = {impact.target_column: impact for impact in evidence.impacts}
    assert by_target["non_negative_balance"].operation == OperationKind.CONSTRAINT
    assert by_target["effective_ead"].operation == OperationKind.ARITHMETIC
    assert by_target["utilization_ratio"].operation == OperationKind.ARITHMETIC
    assert "+" in (by_target["effective_ead"].target_expression or "")
    assert "/" in (by_target["utilization_ratio"].target_expression or "")
    assert ">=" in (by_target["non_negative_balance"].target_expression or "")
    assert by_target["effective_ead"].reason == ImpactReasonCode.INCOMPATIBLE_TYPE


def test_display_graph_only_contains_causal_edges() -> None:
    evidence = build_display_evidence(fixture_result(), fixture_changes())

    pairs = {(edge.source_asset, edge.target_asset) for edge in evidence.edges}
    assert (SOURCE, SILVER) in pairs
    assert (SILVER, GOLD) in pairs
    observed_at = {edge.last_observed_at for edge in evidence.edges}
    assert "2026-09-24T06:58:44.261000Z" in observed_at
    assert "2026-09-24T06:58:47.203000Z" in observed_at
    assert all("payment_events" not in source for source, _target in pairs)
    assert all("delinquency_features" not in target for _source, target in pairs)
    assert all("borrower" not in source for source, _target in pairs)
    assert all("collateral" not in source for source, _target in pairs)
    serialized = evidence.model_dump_json()
    assert "must remain restricted" not in serialized
    assert "free-form model text" not in serialized
