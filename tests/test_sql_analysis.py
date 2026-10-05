from pathlib import Path

import pytest

from lineage_guard.sql_analysis import (
    analyze_sql_change,
    compare_sql_documents,
    parse_sql_document,
)

ROOT = Path(__file__).parents[1]
TRANSFORMATIONS = ROOT / "src" / "credit_risk" / "transformations"
VARIABLES = {
    "catalog": "main",
    "bronze_schema": "proactive_zero_ops_bronze",
    "silver_schema": "proactive_zero_ops_silver",
    "gold_schema": "proactive_zero_ops_gold",
}


@pytest.mark.parametrize("path", sorted(TRANSFORMATIONS.rglob("*.sql")))
def test_every_repository_lakeflow_sql_file_is_fully_supported(path: Path) -> None:
    document = parse_sql_document(path.read_text(), path=str(path), variables=VARIABLES)

    assert document.certainty == "complete", document.issues
    assert document.issues == ()
    assert len(document.statements) == 1
    statement = document.statements[0]
    assert statement.statement_kind == "materialized_view"
    assert statement.output_dataset is not None
    assert statement.output_dataset.startswith("main.proactive_zero_ops_")
    assert statement.output_columns
    assert statement.normalized_ast
    assert statement.semantic_fingerprint


def test_repository_lakeflow_extensions_are_explicitly_parsed() -> None:
    borrowers = parse_repo_sql("bronze/borrowers.sql")
    statement = borrowers.statements[0]
    assert [expectation.name for expectation in statement.expectations] == [
        "valid_borrower_id",
        "positive_income",
    ]
    assert [expectation.action for expectation in statement.expectations] == [
        "FAIL UPDATE",
        "DROP ROW",
    ]
    assert statement.inputs[0].kind == "values"
    assert [column.name for column in statement.output_columns] == [
        "borrower_id",
        "region",
        "industry_sector",
        "annual_income",
        "risk_segment",
        "opened_date",
    ]

    expected_loss = parse_repo_sql("gold/portfolio_expected_loss.sql").statements[0]
    assert "CLUSTER BY" in expected_loss.normalized_sql
    assert "GROUP BY ALL" in expected_loss.normalized_sql
    assert {cast.output_column for cast in expected_loss.explicit_casts} >= {
        "total_ead",
        "expected_loss",
    }

    sector = parse_repo_sql("gold/sector_concentration.sql").statements[0]
    assert "GROUP BY ALL" in sector.normalized_sql
    assert sector.joins[0].relation == "portfolio_totals"
    assert sector.joins[0].condition_sql == "USING (as_of_date)"


def test_streaming_table_stream_and_read_files_sources() -> None:
    sql = """
    CREATE OR REFRESH STREAMING TABLE main.bronze.events AS
    SELECT event_id FROM STREAM(main.raw.events);

    CREATE OR REFRESH MATERIALIZED VIEW main.bronze.files AS
    SELECT payload FROM read_files(
      '/Volumes/main/raw/events',
      format => 'json',
      pathGlobFilter => '*.json'
    );
    """
    document = parse_sql_document(sql, path="pipeline.sql")

    assert document.certainty == "complete", document.issues
    assert [statement.statement_kind for statement in document.statements] == [
        "streaming_table",
        "materialized_view",
    ]
    assert document.statements[0].inputs[0].kind == "stream"
    assert document.statements[0].inputs[0].name == "main.raw.events"
    file_source = document.statements[1].inputs[0]
    assert file_source.kind == "read_files"
    assert file_source.name == "/Volumes/main/raw/events"
    assert "pathGlobFilter".lower() in file_source.evidence_sql.lower()


def test_formatting_and_comments_do_not_produce_a_definition_change() -> None:
    base = """
    CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${schema}.balances (
      CONSTRAINT valid_balance EXPECT (balance >= 0) ON VIOLATION DROP ROW
    ) AS SELECT account_id, CAST(balance AS DECIMAL(18, 2)) AS balance
    FROM ${catalog}.raw.accounts WHERE active = true;
    """
    proposed = """
    -- formatting only
    create or refresh materialized view ${catalog}.${schema}.balances
    (constraint valid_balance expect(balance>=0) on violation drop row)
    as
    select ACCOUNT_ID,
           cast(BALANCE as decimal(18,2)) as BALANCE
      from ${catalog}.raw.accounts
     where ACTIVE=true
    ;
    """
    variables = {"catalog": "main", "schema": "silver"}
    old = parse_sql_document(base, path="balances.sql", variables=variables)
    new = parse_sql_document(proposed, path="balances.sql", variables=variables)
    change = compare_sql_documents(old, new)

    assert old.complete and new.complete
    assert change.kind == "unchanged"
    assert change.formatting_only
    assert not change.semantic_changed
    assert not change.definition_changed
    assert change.statement_changes[0].column_changes == ()
    assert not change.statement_changes[0].expectations_changed


def test_selected_outstanding_balance_break_is_a_structured_column_change() -> None:
    # Keep the numeric baseline independent of the demo's current SQL so this
    # regression still exercises a real before/after change on either PR state.
    path = "loan_accounts.sql"
    base = """
    CREATE OR REFRESH MATERIALIZED VIEW ${catalog}.${bronze_schema}.loan_accounts AS
    SELECT CAST(outstanding_balance_raw AS DECIMAL(18, 2)) AS outstanding_balance
    FROM ${catalog}.raw.loan_accounts;
    """
    proposed = base.replace(
        "CAST(outstanding_balance_raw AS DECIMAL(18, 2)) AS outstanding_balance",
        "CONCAT('AUD ', FORMAT_NUMBER(CAST(outstanding_balance_raw AS DECIMAL(18, 2)), 2)) "
        "AS outstanding_balance",
    )
    change = analyze_sql_change(
        base_sql=base,
        proposed_sql=proposed,
        base_path=str(path),
        base_variables=VARIABLES,
        proposed_variables=VARIABLES,
    )

    assert change.complete
    assert change.semantic_changed
    statement_change = change.statement_changes[0]
    outstanding = next(
        column
        for column in statement_change.column_changes
        if column.proposed_name == "outstanding_balance"
    )
    assert outstanding.kind == "modified"
    assert outstanding.base is not None and outstanding.proposed is not None
    assert outstanding.base.expression_sql == "CAST(outstanding_balance_raw AS DECIMAL(18, 2))"
    assert "CONCAT" in outstanding.proposed.expression_sql
    # The explicit inner cast remains, but deterministic AST comparison sees
    # the new string-producing outer expression.
    assert not statement_change.casts_changed


def test_extracts_inputs_columns_expressions_joins_filters_and_casts() -> None:
    statement = parse_repo_sql("silver/loan_exposure.sql").statements[0]

    assert set(statement.input_tables) == {
        "main.proactive_zero_ops_bronze.loan_accounts",
        "main.proactive_zero_ops_silver.borrower_risk_profile",
    }
    assert statement.joins[0].relation == "main.proactive_zero_ops_silver.borrower_risk_profile"
    assert statement.joins[0].condition_sql == "USING (borrower_id)"
    effective_ead = next(
        column for column in statement.output_columns if column.name == "effective_ead"
    )
    assert "outstanding_balance" in effective_ead.expression_sql
    assert effective_ead.expression_ast.startswith("[")
    assert any(cast.output_column == "effective_ead" for cast in statement.explicit_casts)

    watchlist = parse_repo_sql("gold/delinquency_watchlist.sql").statements[0]
    assert watchlist.filters[0].clause == "where"
    assert "days_past_due" in watchlist.filters[0].expression_sql


def test_addition_deletion_file_rename_and_dataset_rename_are_visible() -> None:
    base = "CREATE VIEW main.s.old_name AS SELECT id FROM main.raw.source"
    proposed = "CREATE VIEW main.s.new_name AS SELECT id FROM main.raw.source"

    added = analyze_sql_change(
        base_sql=None,
        proposed_sql=proposed,
        base_path="new.sql",
    )
    deleted = analyze_sql_change(
        base_sql=base,
        proposed_sql=None,
        base_path="old.sql",
    )
    renamed = analyze_sql_change(
        base_sql=base,
        proposed_sql=proposed,
        base_path="old.sql",
        proposed_path="new.sql",
    )

    assert added.kind == "added"
    assert deleted.kind == "deleted"
    assert renamed.kind == "renamed_modified"
    assert renamed.statement_changes[0].kind == "renamed"
    assert renamed.semantic_changed


@pytest.mark.parametrize(
    "sql, issue_code",
    [
        (
            """
            CREATE OR REFRESH MATERIALIZED VIEW main.s.t (
              CONSTRAINT valid_id EXPECT (id IS NOT NULL) ON VIOLATION QUARANTINE ROW
            ) AS SELECT id FROM main.raw.t
            """,
            "unsupported_lakeflow_expectation",
        ),
        ("APPLY CHANGES INTO main.s.t FROM STREAM(main.raw.t)", "parse_error"),
        ("CREATE OR REFRESH MATERIALIZED VIEW main.s.t AS SELECT ( FROM x", "parse_error"),
    ],
)
def test_unsupported_syntax_is_reported_never_silently_skipped(sql: str, issue_code: str) -> None:
    document = parse_sql_document(sql, path="unsupported.sql")

    assert not document.complete
    assert any(issue.code == issue_code for issue in document.issues)
    if not document.statements:
        assert document.certainty == "failed"


def test_unresolved_target_variable_is_an_explicit_coverage_limitation() -> None:
    document = parse_sql_document(
        "CREATE VIEW ${catalog}.${schema}.v AS SELECT id FROM ${catalog}.raw.t",
        path="variables.sql",
        variables={"catalog": "main"},
    )

    assert document.certainty == "partial"
    assert document.statements
    assert [issue.code for issue in document.issues] == ["unresolved_variable"]
    assert "__unresolved_schema__" in document.output_datasets[0]


def test_schema_only_create_discovers_declared_output_columns() -> None:
    document = parse_sql_document(
        "CREATE TABLE main.s.contract (id BIGINT, balance DECIMAL(18, 2))",
        path="contract.sql",
    )

    assert document.complete, document.issues
    assert [column.name for column in document.statements[0].output_columns] == [
        "id",
        "balance",
    ]


def test_merge_without_enumerable_output_columns_is_an_explicit_limitation() -> None:
    document = parse_sql_document(
        """
        MERGE INTO main.s.target AS t
        USING main.s.source AS s
        ON t.id = s.id
        WHEN MATCHED THEN UPDATE SET t.balance = s.balance
        """,
        path="merge.sql",
    )

    assert not document.complete
    assert any(issue.code == "output_columns_unavailable" for issue in document.issues)


def parse_repo_sql(relative_path: str):
    path = TRANSFORMATIONS / relative_path
    return parse_sql_document(path.read_text(), path=str(path), variables=VARIABLES)
