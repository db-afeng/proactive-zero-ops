from lineage_guard.disclosure import AssessmentReference, prepare_disclosures
from lineage_guard.report import MARKER, render_markdown


def test_report_contains_sticky_marker_and_status() -> None:
    report = render_markdown(
        prepare_disclosures(
            status="error",
            evidence={"error": "warehouse unavailable"},
            reference=AssessmentReference("lgr_0123456789abcdefghijklmnopqrstuv"),
        ).public
    )
    assert report.startswith(MARKER)
    assert "**ERROR**" in report
    assert "warehouse unavailable" not in report
    assert "lgr_0123456789abcdefghijklmnopqrstuv" in report
