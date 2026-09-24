from __future__ import annotations

from lineage_guard.lineage import LineageGraph
from lineage_guard.models import GuardResult, ModelAssessment, Severity


def evaluate_assessment(
    assessment: ModelAssessment,
    graph: LineageGraph,
    changed_tables: set[str],
    changed_files: list[str],
    block_confidence: float,
) -> GuardResult:
    normalized_sources = {table.lower() for table in changed_tables}
    observed_source_columns = {
        (edge.source_table, edge.source_column)
        for edge in graph.edges
        if edge.source_column is not None
    }
    grounded = []
    warnings: list[str] = []
    grounded_columns = []

    for column in assessment.changed_columns:
        if column.table.lower() not in normalized_sources:
            warnings.append(
                f"Rejected ungrounded column claim for {column.table}.{column.column}: "
                "table was not changed"
            )
            continue
        if (column.table.lower(), column.column.lower()) not in observed_source_columns:
            warnings.append(
                f"Rejected ungrounded column claim for {column.table}.{column.column}: "
                "column was not observed in downstream lineage"
            )
            continue
        grounded_columns.append(column)

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
                f"Rejected ungrounded impact for {impact.asset}: lineage path was not observed"
            )
            continue
        grounded.append(impact.model_copy(update={"asset": path[-1], "path": path}))

    should_block = (
        assessment.severity in {Severity.HIGH, Severity.CRITICAL}
        and assessment.confidence >= block_confidence
        and bool(grounded)
    )
    if should_block:
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
        changed_files=changed_files,
        changed_columns=grounded_columns,
        impacts=grounded,
        lineage_edges=graph.edges,
        warnings=warnings,
    )
