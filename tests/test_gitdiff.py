from __future__ import annotations

import subprocess
from pathlib import Path

from lineage_guard.gitdiff import ChangeSet, collect_changes
from lineage_guard.models import EvidenceOrigin

ROOT = Path(__file__).parents[1]


def run(repo: Path, *args: str) -> str:
    return subprocess.run(
        list(args), cwd=repo, check=True, text=True, capture_output=True
    ).stdout.strip()


def initialize_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    run(repo, "git", "init", "-q")
    run(repo, "git", "config", "user.email", "tests@example.com")
    run(repo, "git", "config", "user.name", "Tests")
    return repo


def commit_files(repo: Path, files: dict[str, str | None], message: str) -> str:
    for relative, content in files.items():
        path = repo / relative
        if content is None:
            path.unlink()
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    run(repo, "git", "add", "-A")
    run(repo, "git", "commit", "-qm", message)
    return run(repo, "git", "rev-parse", "HEAD")


def bundle_yaml(*, catalog: str = "dev_catalog", schema: str = "dev_bronze") -> str:
    return f"""
bundle:
  name: risk
include:
  - resources/*.yml
variables:
  catalog:
    default: default_catalog
  bronze_schema:
    default: default_bronze
targets:
  dev:
    default: true
    variables:
      catalog: {catalog}
      bronze_schema: {schema}
"""


PIPELINE_YAML = """
resources:
  schemas:
    bronze:
      catalog_name: ${var.catalog}
      name: ${var.bronze_schema}
  pipelines:
    risk:
      catalog: ${var.catalog}
      schema: ${resources.schemas.bronze.name}
      libraries:
        - glob:
            include: ../src/pipeline/**
      configuration:
        catalog: ${var.catalog}
        schema: ${resources.schemas.bronze.name}
"""


def materialized_view(dataset: str, source: str = "raw.accounts") -> str:
    return f"""
CREATE OR REFRESH MATERIALIZED VIEW ${{catalog}}.${{schema}}.{dataset} (
  CONSTRAINT valid_id EXPECT (account_id IS NOT NULL) ON VIOLATION FAIL UPDATE
) AS
SELECT
  account_id,
  CAST(balance AS DECIMAL(18, 2)) AS balance
FROM ${{catalog}}.{source}
WHERE active = true;
"""


def create_pipeline_repo(tmp_path: Path, sql_files: dict[str, str]) -> tuple[Path, str]:
    repo = initialize_repo(tmp_path)
    files = {
        "databricks.yml": bundle_yaml(),
        "resources/pipeline.yml": PIPELINE_YAML,
    }
    files.update({f"src/pipeline/{name}": sql for name, sql in sql_files.items()})
    return repo, commit_files(repo, files, "base")


def change_by_paths(changes: ChangeSet, before: str | None, after: str | None):
    return next(
        item.change
        for item in changes.sql_changes
        if item.before_path == before and item.after_path == after
    )


def test_repository_bundle_discovers_and_parses_all_lakeflow_sql() -> None:
    changes = collect_changes(ROOT, "HEAD", "HEAD", target="dev")

    assert changes.complete, changes.issues
    assert not changes.has_relevant_changes
    assert len(changes.proposed.documents) == 12
    assert all(document.analysis.complete for document in changes.proposed.documents)
    assert {
        dataset
        for document in changes.proposed.documents
        for dataset in document.analysis.output_datasets
    } == {
        "proactive_zero_ops_catalog.proactive_zero_ops_bronze.borrowers",
        "proactive_zero_ops_catalog.proactive_zero_ops_bronze.collateral",
        "proactive_zero_ops_catalog.proactive_zero_ops_bronze.credit_scores",
        "proactive_zero_ops_catalog.proactive_zero_ops_bronze.loan_accounts",
        "proactive_zero_ops_catalog.proactive_zero_ops_bronze.payment_events",
        "proactive_zero_ops_catalog.proactive_zero_ops_silver.borrower_risk_profile",
        "proactive_zero_ops_catalog.proactive_zero_ops_silver.collateral_adjusted_exposure",
        "proactive_zero_ops_catalog.proactive_zero_ops_silver.delinquency_features",
        "proactive_zero_ops_catalog.proactive_zero_ops_silver.loan_exposure",
        "proactive_zero_ops_catalog.proactive_zero_ops_gold.delinquency_watchlist",
        "proactive_zero_ops_catalog.proactive_zero_ops_gold.portfolio_expected_loss",
        "proactive_zero_ops_catalog.proactive_zero_ops_gold.sector_concentration",
    }


def test_formatting_only_sql_change_is_not_an_impact_change(tmp_path: Path) -> None:
    repo, base = create_pipeline_repo(tmp_path, {"accounts.sql": materialized_view("accounts")})
    formatted = """
-- presentation-only rewrite
create or refresh materialized view ${catalog}.${schema}.accounts
(constraint valid_id expect(account_id is not null) on violation fail update)
as select ACCOUNT_ID, cast(BALANCE as decimal(18,2)) as BALANCE
from ${catalog}.raw.accounts where ACTIVE=true;
"""
    head = commit_files(repo, {"src/pipeline/accounts.sql": formatted}, "format")

    changes = collect_changes(repo, base, head, target="dev")
    document_change = change_by_paths(
        changes, "src/pipeline/accounts.sql", "src/pipeline/accounts.sql"
    )

    assert changes.complete, changes.issues
    assert document_change.formatting_only
    assert document_change.kind == "unchanged"
    assert not document_change.semantic_changed
    assert changes.meaningful_sql_changes == ()
    assert changes.affected_datasets == frozenset()
    assert not changes.has_relevant_changes


def test_target_catalog_and_schema_changes_change_affected_dataset_identities(
    tmp_path: Path,
) -> None:
    repo, base = create_pipeline_repo(tmp_path, {"accounts.sql": materialized_view("accounts")})
    head = commit_files(
        repo,
        {"databricks.yml": bundle_yaml(catalog="next_catalog", schema="next_bronze")},
        "retarget",
    )

    changes = collect_changes(repo, base, head, target="dev")
    sql_change = change_by_paths(changes, "src/pipeline/accounts.sql", "src/pipeline/accounts.sql")

    assert changes.complete, changes.issues
    assert sql_change.kind == "modified"
    assert sql_change.base is not None and sql_change.proposed is not None
    assert sql_change.base.output_datasets == ("dev_catalog.dev_bronze.accounts",)
    assert sql_change.proposed.output_datasets == ("next_catalog.next_bronze.accounts",)
    assert changes.affected_datasets == {
        "dev_catalog.dev_bronze.accounts",
        "next_catalog.next_bronze.accounts",
    }
    assert {field.field for field in changes.bundle_changes.variable_changes} == {
        "variables.bronze_schema",
        "variables.catalog",
    }
    assert any(
        edge.source_table == "next_catalog.raw.accounts"
        and edge.target_table == "next_catalog.next_bronze.accounts"
        and edge.origin == EvidenceOrigin.PROPOSED_CODE
        for edge in changes.proposed_code_edges
    )


def test_sql_additions_deletions_and_file_renames_are_compared_across_revisions(
    tmp_path: Path,
) -> None:
    repo, base = create_pipeline_repo(
        tmp_path,
        {
            "old_name.sql": materialized_view("stable_dataset"),
            "deleted.sql": materialized_view("deleted_dataset"),
        },
    )
    renamed_sql = (repo / "src/pipeline/old_name.sql").read_text()
    added_sql = (
        "CREATE OR REFRESH MATERIALIZED VIEW "
        "${catalog}.${schema}.added_dataset AS "
        "SELECT CAST(seed AS BIGINT) AS new_identifier "
        "FROM VALUES (1), (2), (3) AS source(seed);\n"
    )
    head = commit_files(
        repo,
        {
            "src/pipeline/old_name.sql": None,
            "src/pipeline/renamed.sql": renamed_sql,
            "src/pipeline/deleted.sql": None,
            "src/pipeline/added.sql": added_sql,
        },
        "reshape sources",
    )

    changes = collect_changes(repo, base, head, target="dev")

    assert changes.complete, changes.issues
    assert (
        change_by_paths(changes, "src/pipeline/old_name.sql", "src/pipeline/renamed.sql").kind
        == "renamed"
    )
    assert change_by_paths(changes, "src/pipeline/deleted.sql", None).kind == "deleted"
    assert change_by_paths(changes, None, "src/pipeline/added.sql").kind == "added"
    assert changes.affected_datasets == {
        "dev_catalog.dev_bronze.stable_dataset",
        "dev_catalog.dev_bronze.deleted_dataset",
        "dev_catalog.dev_bronze.added_dataset",
    }


def test_unsupported_lakeflow_syntax_makes_discovery_incomplete(tmp_path: Path) -> None:
    repo, base = create_pipeline_repo(tmp_path, {"accounts.sql": materialized_view("accounts")})
    unsupported = materialized_view("accounts").replace(
        "ON VIOLATION FAIL UPDATE", "ON VIOLATION QUARANTINE ROW"
    )
    head = commit_files(repo, {"src/pipeline/accounts.sql": unsupported}, "unsupported")

    changes = collect_changes(repo, base, head, target="dev")

    assert not changes.complete
    issue = next(
        issue for issue in changes.issues if issue.code == "unsupported_lakeflow_expectation"
    )
    assert issue.revision == head
    assert issue.path == "src/pipeline/accounts.sql"
    proposed = changes.proposed.document_map[("pipelines.risk", "src/pipeline/accounts.sql")]
    assert proposed.analysis.certainty == "partial"
    assert proposed.analysis.statements


def test_changed_non_sql_bundle_source_is_an_explicit_coverage_limitation(
    tmp_path: Path,
) -> None:
    repo, initial = create_pipeline_repo(tmp_path, {"accounts.sql": materialized_view("accounts")})
    job = """
resources:
  jobs:
    features:
      tasks:
        - task_key: prepare
          spark_python_task:
            python_file: ../src/jobs/prepare.py
"""
    # Add the job in both assessed revisions so only its source content changes.
    base = commit_files(
        repo,
        {
            "resources/job.yml": job,
            "src/jobs/prepare.py": "print('base')\n",
        },
        "add job",
    )
    head = commit_files(
        repo,
        {"src/jobs/prepare.py": "print('proposed')\n"},
        "change python",
    )

    changes = collect_changes(repo, base, head, target="dev")

    assert initial != base
    assert not changes.complete
    assert any(
        issue.code == "unsupported_changed_source_language" and issue.path == "src/jobs/prepare.py"
        for issue in changes.issues
    )
    assert changes.has_relevant_changes
