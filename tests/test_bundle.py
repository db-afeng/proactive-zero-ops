from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from lineage_guard.bundle import compare_bundle_snapshots, discover_bundle


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


def write_files(repo: Path, files: dict[str, str | bytes | None]) -> str:
    for relative, content in files.items():
        path = repo / relative
        if content is None:
            path.unlink()
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)
    run(repo, "git", "add", "-A")
    run(repo, "git", "commit", "-qm", "snapshot")
    return run(repo, "git", "rev-parse", "HEAD")


def base_bundle() -> dict[str, str | bytes | None]:
    return {
        "databricks.yml": """
bundle:
  name: test-bundle
include:
  - resources/*.yml
variables:
  catalog:
    default: base_catalog
  bronze_schema:
    default: base_bronze
targets:
  dev:
    default: true
    variables:
      catalog: dev_catalog
      bronze_schema: dev_bronze
  prod:
    variables:
      catalog: prod_catalog
      bronze_schema: prod_bronze
""",
        "resources/pipeline.yml": """
resources:
  schemas:
    bronze:
      catalog_name: ${var.catalog}
      name: ${var.bronze_schema}
  pipelines:
    risk:
      catalog: ${var.catalog}
      schema: ${resources.schemas.bronze.name}
      root_path: ../src/risk
      libraries:
        - glob:
            include: ../src/risk/**/*.sql
""",
        "resources/job.yml": """
resources:
  jobs:
    refresh:
      tasks:
        - task_key: notebook
          notebook_task:
            notebook_path: ../src/jobs/prepare.py
          libraries:
            - whl: ../dist/*.whl
        - task_key: python
          spark_python_task:
            python_file: ../src/jobs/model.py
        - task_key: sql
          sql_task:
            file:
              path: ../src/jobs/check.sql
""",
        "src/risk/bronze/accounts.sql": "SELECT 1 AS account_id\n",
        "src/risk/silver/exposure.sql": "SELECT * FROM accounts\n",
        "src/jobs/prepare.py": "print('prepare')\n",
        "src/jobs/model.py": "print('model')\n",
        "src/jobs/check.sql": "SELECT 1\n",
        "dist/risk.whl": b"wheel",
    }


def test_current_repository_bundle_is_discovered_without_manifest() -> None:
    snapshot = discover_bundle(Path.cwd(), "HEAD", target="dev")

    assert snapshot.complete
    pipeline = snapshot.resource_map["pipelines.credit_risk_pipeline"]
    assert pipeline.config["catalog"] == "proactive_zero_ops_catalog"
    assert pipeline.config["schema"] == "proactive_zero_ops_bronze"
    glob = next(source for source in pipeline.sources if source.kind == "pipeline_glob")
    assert glob.declaring_file == "resources/credit_risk.pipeline.yml"
    assert glob.resolved_path == "src/credit_risk/transformations/**"
    assert len(glob.matches) == 12
    assert "lineage_guard.yml" not in snapshot.included_files


def test_target_variables_and_resource_references_resolve_statically(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    revision = write_files(repo, base_bundle())

    dev = discover_bundle(repo, revision, target="dev")
    prod = discover_bundle(repo, revision, target="prod")

    assert dev.variables == {"catalog": "dev_catalog", "bronze_schema": "dev_bronze"}
    assert prod.variables == {"catalog": "prod_catalog", "bronze_schema": "prod_bronze"}
    assert dev.resource_map["pipelines.risk"].config["catalog"] == "dev_catalog"
    assert dev.resource_map["pipelines.risk"].config["schema"] == "dev_bronze"
    assert prod.resource_map["pipelines.risk"].config["schema"] == "prod_bronze"
    comparison = compare_bundle_snapshots(dev, prod)
    assert {change.field for change in comparison.variable_changes} == {
        "variables.bronze_schema",
        "variables.catalog",
    }
    assert any(
        change.kind == "modified"
        and change.after is not None
        and change.after.identity == "pipelines.risk"
        and {field.field for field in change.fields} >= {"catalog", "schema"}
        for change in comparison.resource_changes
    )


def test_discovers_job_task_sources_and_library_globs(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    revision = write_files(repo, base_bundle())

    snapshot = discover_bundle(repo, revision, target="dev")
    job = snapshot.resource_map["jobs.refresh"]
    sources = {(source.task_key, source.kind): source for source in job.sources}

    assert sources[("notebook", "job_notebook")].matches == ("src/jobs/prepare.py",)
    assert sources[("python", "job_python")].matches == ("src/jobs/model.py",)
    assert sources[("sql", "job_sql")].matches == ("src/jobs/check.sql",)
    assert sources[("notebook", "job_library_whl")].resolved_path == "dist/*.whl"
    assert sources[("notebook", "job_library_whl")].matches == ("dist/risk.whl",)
    assert all(source.declaring_file == "resources/job.yml" for source in job.sources)


def test_pipeline_glob_expands_only_files_in_the_revision(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    revision = write_files(repo, base_bundle())
    snapshot = discover_bundle(repo, revision, target="dev")

    pipeline = snapshot.resource_map["pipelines.risk"]
    source = next(item for item in pipeline.sources if item.kind == "pipeline_glob")
    assert source.matches == (
        "src/risk/bronze/accounts.sql",
        "src/risk/silver/exposure.sql",
    )
    assert len(source.content_hashes) == 2


def test_target_resource_override_path_is_relative_to_declaring_yaml(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    files = base_bundle()
    files["databricks.yml"] = (
        str(files["databricks.yml"])
        + """
    resources:
      pipelines:
        risk:
          catalog: prod_override
          libraries:
            - file:
                path: ./src/override.sql
"""
    )
    files["src/override.sql"] = "SELECT 2\n"
    revision = write_files(repo, files)

    snapshot = discover_bundle(repo, revision, target="prod")
    pipeline = snapshot.resource_map["pipelines.risk"]
    source = next(item for item in pipeline.sources if item.kind == "pipeline_file")
    assert pipeline.config["catalog"] == "prod_override"
    assert source.declaring_file == "databricks.yml"
    assert source.resolved_path == "src/override.sql"
    assert source.matches == ("src/override.sql",)


def test_compare_captures_config_source_add_delete_and_renames(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    base_files = base_bundle()
    base_files["resources/obsolete.yml"] = """
resources:
  jobs:
    obsolete:
      name: obsolete
      tasks: []
"""
    base = write_files(repo, base_files)

    pipeline = str(base_files["resources/pipeline.yml"])
    pipeline = pipeline.replace("pipelines:\n    risk:", "pipelines:\n    renamed_risk:")
    job = str(base_files["resources/job.yml"])
    job = job.replace("../src/jobs/model.py", "../src/jobs/model_v2.py")
    head = write_files(
        repo,
        {
            "resources/pipeline.yml": pipeline,
            "resources/job.yml": job,
            "resources/obsolete.yml": None,
            "src/jobs/model.py": None,
            "src/jobs/model_v2.py": "print('model')\n",
            "resources/added.yml": """
resources:
  jobs:
    added:
      name: added
      tasks: []
""",
        },
    )

    changes = compare_bundle_snapshots(
        discover_bundle(repo, base, target="dev"),
        discover_bundle(repo, head, target="dev"),
    )

    assert any(
        change.kind == "renamed"
        and change.before is not None
        and change.before.identity == "pipelines.risk"
        and change.after is not None
        and change.after.identity == "pipelines.renamed_risk"
        for change in changes.resource_changes
    )
    assert any(
        change.kind == "added"
        and change.after is not None
        and change.after.identity == "jobs.added"
        for change in changes.resource_changes
    )
    assert any(
        change.kind == "deleted"
        and change.before is not None
        and change.before.identity == "jobs.obsolete"
        for change in changes.resource_changes
    )
    assert any(
        change.kind == "modified"
        and change.after is not None
        and change.after.identity == "jobs.refresh"
        for change in changes.resource_changes
    )
    assert any(
        change.kind == "renamed"
        and change.before_path == "src/jobs/model.py"
        and change.after_path == "src/jobs/model_v2.py"
        for change in changes.source_changes
    )


def test_compare_captures_catalog_schema_and_pipeline_source_changes(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    base_files = base_bundle()
    base = write_files(repo, base_files)
    changed = str(base_files["resources/pipeline.yml"])
    changed = changed.replace("catalog: ${var.catalog}", "catalog: replacement_catalog", 1)
    changed = changed.replace(
        "schema: ${resources.schemas.bronze.name}", "schema: replacement_schema"
    )
    changed = changed.replace("../src/risk/**/*.sql", "../src/replacement/**/*.sql")
    head = write_files(
        repo,
        {
            "resources/pipeline.yml": changed,
            "src/replacement/new.sql": "SELECT 3\n",
        },
    )

    changes = compare_bundle_snapshots(
        discover_bundle(repo, base, target="dev"),
        discover_bundle(repo, head, target="dev"),
    )
    pipeline_change = next(
        change
        for change in changes.resource_changes
        if change.after is not None and change.after.identity == "pipelines.risk"
    )
    assert {field.field for field in pipeline_change.fields} >= {
        "catalog",
        "schema",
        "libraries",
        "sources",
    }
    assert any(
        change.kind == "added" and change.after_path == "src/replacement/new.sql"
        for change in changes.source_changes
    )


def test_declared_warehouse_runtime_id_is_allowed_for_consumers_and_app_bindings(
    tmp_path: Path,
) -> None:
    repo = initialize_repo(tmp_path)
    files = base_bundle()
    files["resources/consumer.yml"] = """
resources:
  sql_warehouses:
    risk:
      name: risk-warehouse
  dashboards:
    exposure:
      warehouse_id: ${resources.sql_warehouses.risk.id}
  genie_spaces:
    explorer:
      warehouse_id: ${resources.sql_warehouses.risk.id}
  apps:
    studio:
      name: studio
      resources:
        - name: sql-warehouse
          sql_warehouse:
            id: ${resources.sql_warehouses.risk.id}
            permission: CAN_USE
"""
    revision = write_files(repo, files)

    snapshot = discover_bundle(repo, revision, target="dev")

    assert snapshot.complete, snapshot.issues
    assert snapshot.resource_map["dashboards.exposure"].config["warehouse_id"] == (
        "${resources.sql_warehouses.risk.id}"
    )
    assert snapshot.resource_map["genie_spaces.explorer"].config["warehouse_id"] == (
        "${resources.sql_warehouses.risk.id}"
    )
    assert snapshot.resource_map["apps.studio"].config["resources"][0]["sql_warehouse"][
        "id"
    ] == "${resources.sql_warehouses.risk.id}"


@pytest.mark.parametrize(
    "consumer_config",
    [
        "dashboards:\n    exposure:\n      warehouse_id: ${resources.sql_warehouses.missing.id}",
        "dashboards:\n    exposure:\n      warehouse_id: ${resources.pipelines.risk.id}",
        "dashboards:\n    exposure:\n      dataset_catalog: ${resources.sql_warehouses.risk.id}",
        (
            "dashboards:\n    exposure:\n"
            "      warehouse_id: prefix-${resources.sql_warehouses.risk.id}"
        ),
        "pipelines:\n    risk:\n      warehouse_id: ${resources.sql_warehouses.risk.id}",
        "apps:\n    studio:\n      source_code_path: ${resources.sql_warehouses.risk.id}",
        (
            "apps:\n    studio:\n      resources:\n        - name: sql-warehouse\n"
            "          sql_warehouse:\n            id: ${resources.sql_warehouses.missing.id}"
        ),
        (
            "apps:\n    studio:\n      resources:\n        - name: sql-warehouse\n"
            "          sql_warehouse:\n            id: prefix-${resources.sql_warehouses.risk.id}"
        ),
    ],
)
def test_other_runtime_id_references_remain_discovery_limitations(
    tmp_path: Path, consumer_config: str
) -> None:
    repo = initialize_repo(tmp_path)
    files = base_bundle()
    files["resources/consumer.yml"] = (
        "resources:\n  sql_warehouses:\n    risk:\n      name: risk-warehouse\n  "
        + consumer_config
        + "\n"
    )
    revision = write_files(repo, files)

    snapshot = discover_bundle(repo, revision, target="dev")

    assert not snapshot.complete
    assert any(issue.code == "unsupported_dynamic_substitution" for issue in snapshot.issues)


def test_dynamic_and_executable_configuration_is_explicitly_unsupported(
    tmp_path: Path,
) -> None:
    repo = initialize_repo(tmp_path)
    revision = write_files(
        repo,
        {
            "databricks.yml": """
bundle:
  name: unsafe
include:
  - resources/*.yml
scripts:
  deploy:
    content: python mutate.py
experimental:
  python:
    resources:
      - "mutator:load"
artifacts:
  wheel:
    type: whl
    build: python -m build
variables:
  catalog:
    lookup:
      catalog: shared
resources:
  pipelines:
    dynamic:
      catalog: ${var.catalog}
      schema: ${workspace.current_user.short_name}
      libraries:
        - glob:
            include: src/missing/**
""",
        },
    )

    snapshot = discover_bundle(repo, revision)
    codes = {issue.code for issue in snapshot.issues}

    assert not snapshot.complete
    assert codes >= {
        "include_no_matches",
        "unsupported_executable_configuration",
        "unsupported_bundle_mutator",
        "unsupported_artifact_build",
        "unsupported_dynamic_variable",
        "unresolved_substitution",
        "unsupported_dynamic_substitution",
        "source_no_matches",
    }


def test_safe_yaml_loader_rejects_python_tags_without_execution(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    revision = write_files(
        repo,
        {
            "databricks.yml": (
                "bundle: !!python/object/apply:os.system ['touch should-not-exist']\n"
            )
        },
    )

    snapshot = discover_bundle(repo, revision)

    assert not (repo / "should-not-exist").exists()
    assert [issue.code for issue in snapshot.issues] == ["invalid_or_unsafe_yaml"]
    assert not snapshot.complete
