from __future__ import annotations

import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
APP_NAME = "lineage_impact_studio"
CALLBACK = (
    "https://lineage-impact-studio-7474645195281143.aws.databricksapps.com"
    "/api/github/oauth/callback"
)


def test_github_oauth_runtime_uses_secret_resource_bindings() -> None:
    app_config = yaml.safe_load(
        (ROOT / "apps/lineage-impact-studio/app.yaml").read_text()
    )
    environment = {entry["name"]: entry for entry in app_config["env"]}

    assert environment["GITHUB_CLIENT_ID"] == {
        "name": "GITHUB_CLIENT_ID",
        "valueFrom": "github-client-id",
    }
    assert environment["GITHUB_CLIENT_SECRET"] == {
        "name": "GITHUB_CLIENT_SECRET",
        "valueFrom": "github-client-secret",
    }
    assert environment["GITHUB_REDIRECT_URI"] == {
        "name": "GITHUB_REDIRECT_URI",
        "value": CALLBACK,
    }
    fix_callback = CALLBACK.replace("/api/github/", "/api/databricks/")
    assert environment["DATABRICKS_FIX_OAUTH_REDIRECT_URI"] == {
        "name": "DATABRICKS_FIX_OAUTH_REDIRECT_URI",
        "value": fix_callback,
    }
    fix_integration = json.loads(
        (ROOT / "apps/lineage-impact-studio/databricks-fix-oauth-integration.json").read_text()
    )
    assert fix_integration["redirect_urls"] == [fix_callback]


def test_bundle_declares_both_github_secret_resources() -> None:
    resource_config = yaml.safe_load(
        (ROOT / "resources/lineage_impact_studio.app.yml").read_text()
    )
    resources = resource_config["resources"]["apps"][APP_NAME]["resources"]
    by_name = {resource["name"]: resource for resource in resources}

    assert by_name["github-client-id"]["secret"] == {
        "scope": "${var.lineage_impact_secret_scope}",
        "key": "${var.lineage_impact_github_client_id_secret_key}",
        "permission": "READ",
    }
    assert by_name["github-client-secret"]["secret"] == {
        "scope": "${var.lineage_impact_secret_scope}",
        "key": "${var.lineage_impact_github_client_secret_secret_key}",
        "permission": "READ",
    }


def test_app_and_pipeline_bundle_use_the_same_workspace_warehouse() -> None:
    root_bundle = yaml.safe_load((ROOT / "databricks.yml").read_text())
    app_bundle = yaml.safe_load(
        (ROOT / "apps/lineage-impact-studio/databricks.yml").read_text()
    )
    resource_config = yaml.safe_load(
        (ROOT / "resources/lineage_impact_studio.app.yml").read_text()
    )
    warehouse_name = yaml.safe_load(
        (ROOT / "resources/lineage_guard.sql_warehouse.yml").read_text()
    )["resources"]["sql_warehouses"]["lineage_guard"]["name"]

    assert root_bundle["targets"]["dev"]["workspace"]["host"] == (
        "https://fe-sandbox-proactive-zero-ops-2.cloud.databricks.com"
    )
    assert app_bundle["targets"]["default"]["workspace"] == (
        root_bundle["targets"]["dev"]["workspace"]
    )
    assert app_bundle["variables"]["sql_warehouse_id"]["lookup"] == {
        "warehouse": warehouse_name
    }
    resources = resource_config["resources"]["apps"][APP_NAME]["resources"]
    by_name = {resource["name"]: resource for resource in resources}
    assert by_name["sql-warehouse"]["sql_warehouse"] == {
        "id": "${resources.sql_warehouses.lineage_guard.id}",
        "permission": "CAN_USE",
    }


def test_evidence_volume_binding_matches_bundle_managed_storage() -> None:
    root_bundle = yaml.safe_load((ROOT / "databricks.yml").read_text())
    app_bundle = yaml.safe_load(
        (ROOT / "apps/lineage-impact-studio/databricks.yml").read_text()
    )
    guard_schema = yaml.safe_load((ROOT / "resources/lineage_guard.schemas.yml").read_text())[
        "resources"
    ]["schemas"]["lineage_guard_evidence"]
    volume = yaml.safe_load((ROOT / "resources/lineage_guard.volume.yml").read_text())[
        "resources"
    ]["volumes"]["restricted_assessments"]

    assert guard_schema["catalog_name"] == volume["catalog_name"] == "${var.catalog}"
    assert volume["schema_name"] == "${resources.schemas.lineage_guard_evidence.name}"
    assert volume["volume_type"] == "MANAGED"
    full_name = ".".join(
        [
            root_bundle["variables"]["catalog"]["default"],
            guard_schema["name"],
            volume["name"],
        ]
    )
    assert root_bundle["variables"]["lineage_impact_volume"]["default"] == full_name
    assert app_bundle["targets"]["default"]["variables"]["files_id"] == full_name


def test_live_usage_has_matching_obo_scopes_and_lineage_grant() -> None:
    bundles = (
        (ROOT / "resources/lineage_impact_studio.app.yml", APP_NAME),
        (ROOT / "apps/lineage-impact-studio/databricks.yml", "app"),
    )
    for path, resource_name in bundles:
        config = yaml.safe_load(path.read_text())
        app = config["resources"]["apps"][resource_name]
        assert set(app["user_api_scopes"]) == {
            "sql",
            "genie",
            "workspace.workspace:read",
        }
        lineage_resources = [
            item["uc_securable"]
            for item in app["resources"]
            if item.get("uc_securable", {}).get("securable_full_name")
            == "system.access.table_lineage"
        ]
        assert lineage_resources == [
            {
                "securable_full_name": "system.access.table_lineage",
                "securable_type": "TABLE",
                "permission": "SELECT",
            }
        ]
