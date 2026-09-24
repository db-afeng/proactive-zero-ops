from lineage_guard.models import GuardResult, Severity
from lineage_guard.report import MARKER, render_markdown


def test_report_contains_sticky_marker_and_status() -> None:
    report = render_markdown(
        GuardResult(
            status="error",
            severity=Severity.NONE,
            summary="Assessment failed.",
            error="warehouse unavailable",
        )
    )
    assert report.startswith(MARKER)
    assert "**ERROR**" in report
    assert "warehouse unavailable" in report
