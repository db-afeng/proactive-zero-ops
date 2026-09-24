import subprocess
from pathlib import Path

import pytest

from lineage_guard.config import GuardConfig
from lineage_guard.gitdiff import CoverageError, collect_changes


def run(repo: Path, *args: str) -> str:
    return subprocess.run(
        list(args), cwd=repo, check=True, text=True, capture_output=True
    ).stdout.strip()


def make_repo(tmp_path: Path) -> tuple[Path, str, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    run(repo, "git", "init", "-q")
    run(repo, "git", "config", "user.email", "tests@example.com")
    run(repo, "git", "config", "user.name", "Tests")
    transformations = repo / "src" / "credit_risk" / "transformations"
    transformations.mkdir(parents=True)
    sql = transformations / "accounts.sql"
    sql.write_text("SELECT CAST(balance AS DECIMAL(18,2)) AS balance\n")
    run(repo, "git", "add", ".")
    run(repo, "git", "commit", "-qm", "base")
    base = run(repo, "git", "rev-parse", "HEAD")
    sql.write_text("SELECT concat('$', balance) AS balance\n")
    run(repo, "git", "add", ".")
    run(repo, "git", "commit", "-qm", "head")
    head = run(repo, "git", "rev-parse", "HEAD")
    return repo, base, head


def config(mapped: bool = True) -> GuardConfig:
    datasets = {}
    if mapped:
        datasets["src/credit_risk/transformations/accounts.sql"] = {
            "table": "main.bronze.accounts",
            "layer": "bronze",
        }
    return GuardConfig.model_validate(
        {
            "version": 1,
            "settings": {"governed_roots": ["src/credit_risk/transformations"]},
            "datasets": datasets,
        }
    )


def test_collects_diff_without_executing_head(tmp_path: Path) -> None:
    repo, base, head = make_repo(tmp_path)
    changes = collect_changes(repo, config(), base, head)
    assert len(changes.datasets) == 1
    assert "concat('$', balance)" in changes.datasets[0].head_sql
    assert "DECIMAL(18,2)" in changes.datasets[0].base_sql
    assert changes.datasets[0].table == "main.bronze.accounts"


def test_unmapped_governed_sql_fails_closed(tmp_path: Path) -> None:
    repo, base, head = make_repo(tmp_path)
    with pytest.raises(CoverageError):
        collect_changes(repo, config(mapped=False), base, head)
