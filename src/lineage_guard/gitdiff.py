from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from lineage_guard.config import GuardConfig


class GitError(RuntimeError):
    pass


class CoverageError(RuntimeError):
    pass


@dataclass(frozen=True)
class ChangedDataset:
    path: str
    table: str
    base_sql: str
    head_sql: str
    diff: str


@dataclass(frozen=True)
class ChangeSet:
    base_sha: str
    head_sha: str
    changed_files: list[str]
    datasets: list[ChangedDataset]


def _git(repo: Path, args: list[str], *, allow_failure: bool = False) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode and not allow_failure:
        raise GitError(completed.stderr.strip() or f"git command failed: {' '.join(args)}")
    return completed.stdout


def resolve_commit(repo: Path, ref: str) -> str:
    output = _git(repo, ["rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"])
    return output.strip()


def read_file_at_commit(repo: Path, sha: str, path: str) -> str:
    return _git(repo, ["show", f"{sha}:{path}"], allow_failure=True)


def collect_changes(repo: Path, config: GuardConfig, base: str, head: str) -> ChangeSet:
    base_sha = resolve_commit(repo, base)
    head_sha = resolve_commit(repo, head)
    governed_at_head = _git(
        repo,
        [
            "ls-tree",
            "-r",
            "--name-only",
            head_sha,
            "--",
            *config.settings.governed_roots,
        ],
    ).splitlines()
    missing_from_manifest = sorted(
        path for path in governed_at_head if path.endswith(".sql") and path not in config.datasets
    )
    if missing_from_manifest:
        joined = ", ".join(missing_from_manifest)
        raise CoverageError(f"governed SQL files are missing from lineage_guard.yml: {joined}")

    changed = _git(
        repo,
        [
            "diff",
            "--name-only",
            "--no-renames",
            base_sha,
            head_sha,
            "--",
            *config.settings.governed_roots,
        ],
    ).splitlines()
    changed_files = sorted(path for path in changed if path)

    governed_sql = [path for path in changed_files if path.endswith(".sql")]
    unmapped = sorted(set(governed_sql) - set(config.datasets))
    if unmapped:
        joined = ", ".join(unmapped)
        raise CoverageError(f"governed SQL files are missing from lineage_guard.yml: {joined}")

    datasets: list[ChangedDataset] = []
    for path in governed_sql:
        dataset = config.datasets[path]
        diff = _git(
            repo,
            [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=40",
                base_sha,
                head_sha,
                "--",
                path,
            ],
        )
        datasets.append(
            ChangedDataset(
                path=path,
                table=dataset.table,
                base_sql=read_file_at_commit(repo, base_sha, path),
                head_sql=read_file_at_commit(repo, head_sha, path),
                diff=diff,
            )
        )

    return ChangeSet(
        base_sha=base_sha,
        head_sha=head_sha,
        changed_files=changed_files,
        datasets=datasets,
    )
