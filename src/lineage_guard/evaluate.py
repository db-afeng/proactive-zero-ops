from __future__ import annotations

from lineage_guard.lineage import LineageGraph
from lineage_guard.models import (
    DiscoveryCertainty,
    GuardResult,
    ModelAssessment,
    Severity,
)


def evaluate_assessment(
    assessment: ModelAssessment,
    graph: LineageGraph,
    changed_tables: set[str],
    changed_files: list[str],
    block_confidence: float,
    *,
    discovery_complete: bool = True,
    coverage_limitations: list[str] | None = None,
    semantic_changes: list[dict[str, object]] | None = None,
    bundle_changes: list[dict[str, object]] | None = None,
) -> GuardResult:
    normalized_sources = {table.lower() for table in changed_tables}
    grounded = []
    warnings: list[str] = []
    limitations = list(coverage_limitations or [])

    for impact in assessment.impacts:
        path = [part.lower() for part in impact.path]
        if path[0] not in normalized_sources:
            warnings.append(
                f"Rejected ungrounded impact for {impact.asset}: path has no changed source"
            )
            continue
        if impact.asset.lower() != path[-1]:
            warnings.append(
                f"Rejected ungrounded impact for {impact.asset}: asset does not end its path"
            )
            continue
        if not graph.has_path(path):
            warnings.append(
                f"Rejected ungrounded impact for {impact.asset}: dependency path was not verified"
            )
            continue
        grounded.append(impact.model_copy(update={"asset": path[-1], "path": path}))

    should_block = (
        discovery_complete
        and assessment.severity in {Severity.HIGH, Severity.CRITICAL}
        and assessment.confidence >= block_confidence
        and bool(grounded)
    )
    if not discovery_complete:
        status = "error"
    elif should_block:
        status = "block"
    elif assessment.severity in {Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL} or warnings:
        status = "warn"
    else:
        status = "pass"

    if assessment.impacts and not grounded:
        warnings.append(
            "No model impact survived deterministic lineage grounding; blocking was suppressed."
        )

    return GuardResult(
        status=status,
        severity=assessment.severity,
        confidence=assessment.confidence,
        summary=assessment.summary,
        assessment_complete=discovery_complete,
        discovery_certainty=(
            DiscoveryCertainty.COMPLETE if discovery_complete else DiscoveryCertainty.INCOMPLETE
        ),
        changed_files=changed_files,
        impacts=grounded,
        lineage_edges=graph.edges,
        semantic_changes=semantic_changes or [],
        bundle_changes=bundle_changes or [],
        coverage_limitations=limitations,
        warnings=warnings,
    )
