from __future__ import annotations

from pathlib import Path

WORKFLOW = Path(".github/workflows/downstream-impact.yml")


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
