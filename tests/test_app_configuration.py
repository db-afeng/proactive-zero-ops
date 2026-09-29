from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
APP_NAME = "lineage_impact_studio"
CALLBACK = (
    "https://lineage-impact-studio-7474650525906616.aws.databricksapps.com"
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
