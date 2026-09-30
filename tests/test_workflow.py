from __future__ import annotations

from pathlib import Path

WORKFLOW = Path(".github/workflows/downstream-impact.yml")


def test_trusted_checker_uses_pull_request_target_workflow_commit() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    checkout = workflow.split(
        "name: Check out trusted workflow implementation", maxsplit=1
    )[1].split("name: Fetch untrusted head as data only", maxsplit=1)[0]
    assert "ref: ${{ github.sha }}" in checkout
    assert "github.event.pull_request.base.sha" not in checkout


def test_restricted_evidence_is_published_before_public_report_is_prepared() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    publish = workflow.index("name: Publish restricted assessment evidence")
    sanitize = workflow.index("name: Prepare allowlisted public assessment")
    link = workflow.index("name: Add authorized assessment link")
    comment = workflow.index("name: Create or update pull-request report")

    assert publish < sanitize < link < comment
    assert 'and sys.argv[3] == "true"' in workflow
    assert (
        "steps.public.outputs.assessment_reference == "
        "steps.publication.outputs.assessment_reference"
    ) in workflow
    receipt_argument = (
        '--publication-receipt "$LINEAGE_GUARD_RESTRICTED_DIR/publication-receipt.json"'
    )
    assert receipt_argument in workflow
    assert "LINEAGE_IMPACT_STUDIO_URL" in workflow


def test_workflow_binds_envelope_to_pr_and_uploads_only_public_artifacts() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert '--repository "$GITHUB_REPOSITORY"' in workflow
    assert '--pull-request-number "${{ github.event.pull_request.number }}"' in workflow
    upload = workflow.split("name: Upload public assessment", maxsplit=1)[1].split(
        "name: Create or update pull-request report", maxsplit=1
    )[0]
    assert "assessment.json" in upload
    assert "assessment.md" in upload
    assert "LINEAGE_GUARD_RESTRICTED_DIR" not in upload
    assert "restricted" not in upload.lower()


def test_automatic_fix_starts_for_every_failed_assessment() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    automatic_fix = workflow.split(
        "name: Start and finalize automatic fix proposal", maxsplit=1
    )[1].split("name: Write job summary", maxsplit=1)[0]
    assert "steps.public.outputs.exit_code == '1'" in automatic_fix
    assert "steps.public.outputs.exit_code == '2'" in automatic_fix
    assert "steps.public.outputs.exit_code == '0'" not in automatic_fix


def test_automatic_fix_uses_a_short_lived_caller_owned_git_credential() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    automatic_fix = workflow.split(
        "name: Start and finalize automatic fix proposal", maxsplit=1
    )[1].split("name: Write job summary", maxsplit=1)[0]
    assert "workspace.git_credentials.create(" in automatic_fix
    assert '"gitCredentialId": git_credential_id' in automatic_fix
    assert "finally:" in automatic_fix
    assert "workspace.git_credentials.delete(git_credential_id)" in automatic_fix
