"""Deterministic, browser-safe facts for explaining a lineage assessment.

The full restricted envelope may contain model prose and source SQL.  This
module creates a strict structured projection from the trusted SQL analysis and
verified lineage graph.  The app can template concise explanations from these
facts without ever sending arbitrary model text to the browser.
"""

from __future__ import annotations

import re
from collections import defaultdict
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from lineage_guard.gitdiff import ChangeSet
from lineage_guard.models import GuardResult, LineageEdge


class TypeFamily(StrEnum):
    NUMERIC = "numeric"
    TEXT = "text"
    BOOLEAN = "boolean"
    DATE = "date"
    TIMESTAMP = "timestamp"
    COMPLEX = "complex"
    UNKNOWN = "unknown"


class OperationKind(StrEnum):
    ARITHMETIC = "arithmetic"
    AGGREGATE = "aggregate"
    COMPARISON = "comparison"
    FILTER = "filter"
    JOIN = "join"
    CAST = "cast"
    CONSTRAINT = "constraint"
    PASS_THROUGH = "pass_through"
    UNKNOWN = "unknown"


class ImpactReasonCode(StrEnum):
    INCOMPATIBLE_TYPE = "incompatible_type"
    MISSING_COLUMN = "missing_column"
    RENAMED_COLUMN = "renamed_column"
    INCOMPATIBLE_OPERATION = "incompatible_operation"
    SEMANTIC_CHANGE = "semantic_change"
    UPSTREAM_FAILURE = "upstream_failure"
    MANUAL_REVIEW = "manual_review"


class RemediationKind(StrEnum):
    RESTORE_CONTRACT = "restore_contract"
    ADD_COMPATIBILITY_COLUMN = "add_compatibility_column"
    UPDATE_CONSUMERS = "update_consumers"
    REASSESS = "reassess"


class DisplayChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    asset: str
    column: str
    change_kind: str
    before_type: TypeFamily
    after_type: TypeFamily
    before_expression: str | None = None
    after_expression: str | None = None
    file_path: str | None = None


class DisplayImpact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    change_id: str
    relation: str
    target_asset: str
    target_column: str | None = None
    operation: OperationKind
    reason: ImpactReasonCode
    evidence_level: str
    path: list[str] = Field(min_length=1)
    target_expression: str | None = None
    remediation: RemediationKind


class DisplayEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    source_asset: str
    target_asset: str
    source_column: str | None = None
    target_column: str | None = None
    level: str
    origins: list[str]
    last_observed_at: str | None = None


class DisplayEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    headline: str
    recommended_action: str
    changes: list[DisplayChange]
    impacts: list[DisplayImpact]
    edges: list[DisplayEdge]


def build_display_evidence(
    result: GuardResult,
    changes: ChangeSet | None,
) -> DisplayEvidence:
    """Build a deterministic explanation payload for the restricted envelope."""

    if changes is None:
        return _empty_evidence(result)

    display_changes = _collect_changes(changes)
    impacts = _collect_direct_impacts(changes, display_changes)
    impacts.extend(_collect_transitive_impacts(result, display_changes, impacts))
    edges = _collect_edges(result.lineage_edges, impacts)
    headline, recommended_action = _messages(result, display_changes, impacts)
    return DisplayEvidence(
        headline=headline,
        recommended_action=recommended_action,
        changes=display_changes,
        impacts=impacts,
        edges=edges,
    )


def _empty_evidence(result: GuardResult) -> DisplayEvidence:
    headline = {
        "pass": "No blocking downstream impact was identified.",
        "warn": "A downstream change needs review before merging.",
        "block": "A verified downstream contract may break.",
        "error": "The assessment could not establish a safe result.",
    }[result.status]
    return DisplayEvidence(
        headline=headline,
        recommended_action="Re-run the assessment after resolving the reported coverage issue.",
        changes=[],
        impacts=[],
        edges=[],
    )


def _collect_changes(changes: ChangeSet) -> list[DisplayChange]:
    result: list[DisplayChange] = []
    for sql_change in changes.meaningful_sql_changes:
        for statement_change in sql_change.change.statement_changes:
            statement = statement_change.proposed or statement_change.base
            if statement is None or statement.output_dataset is None:
                continue
            for column_change in statement_change.column_changes:
                column = column_change.proposed_name or column_change.base_name
                if column is None:
                    continue
                before = column_change.base.expression_sql if column_change.base else None
                after = column_change.proposed.expression_sql if column_change.proposed else None
                result.append(
                    DisplayChange(
                        id=f"change-{len(result) + 1}",
                        asset=statement.output_dataset.lower(),
                        column=column.lower(),
                        change_kind=column_change.kind,
                        before_type=_type_family(before),
                        after_type=_type_family(after),
                        before_expression=before,
                        after_expression=after,
                        file_path=sql_change.after_path or sql_change.before_path,
                    )
                )
    return result


def _collect_direct_impacts(
    changes: ChangeSet,
    display_changes: list[DisplayChange],
) -> list[DisplayImpact]:
    result: list[DisplayImpact] = []
    statements = [
        statement
        for document in changes.proposed.documents
        for statement in document.analysis.statements
        if statement.output_dataset is not None
    ]

    for change in display_changes:
        for statement in statements:
            target_asset = statement.output_dataset
            if target_asset is None:
                continue
            if target_asset.lower() == change.asset:
                for expectation in statement.expectations:
                    if _references_column(expectation.expression_sql, change.column):
                        result.append(
                            _impact(
                                result,
                                change,
                                target_asset=change.asset,
                                target_column=expectation.name,
                                operation=OperationKind.CONSTRAINT,
                                expression=expectation.expression_sql,
                                path=[change.asset],
                                evidence_level="definition",
                            )
                        )
                continue

            if change.asset not in {name.lower() for name in statement.input_tables}:
                continue
            for output in statement.output_columns:
                if not any(_column_name(value) == change.column for value in output.source_columns):
                    continue
                operation = _operation(output.expression_sql, change.column)
                result.append(
                    _impact(
                        result,
                        change,
                        target_asset=target_asset.lower(),
                        target_column=output.name,
                        operation=operation,
                        expression=output.expression_sql,
                        path=[change.asset, target_asset.lower()],
                        evidence_level="definition",
                    )
                )
    return result


def _impact(
    existing: list[DisplayImpact],
    change: DisplayChange,
    *,
    target_asset: str,
    target_column: str | None,
    operation: OperationKind,
    expression: str | None,
    path: list[str],
    evidence_level: str,
) -> DisplayImpact:
    reason, remediation = _reason_and_remediation(change, operation)
    return DisplayImpact(
        id=f"impact-{len(existing) + 1}",
        change_id=change.id,
        relation="direct",
        target_asset=target_asset,
        target_column=target_column,
        operation=operation,
        reason=reason,
        evidence_level=evidence_level,
        path=path,
        target_expression=expression,
        remediation=remediation,
    )


def _collect_transitive_impacts(
    result: GuardResult,
    changes: list[DisplayChange],
    direct_impacts: list[DisplayImpact],
) -> list[DisplayImpact]:
    if not changes:
        return []
    direct_targets = {(impact.change_id, impact.target_asset) for impact in direct_impacts}
    collected: list[DisplayImpact] = []
    for grounded in result.impacts:
        normalized_path = [asset.lower() for asset in grounded.path]
        change = next((item for item in changes if normalized_path[0] == item.asset), None)
        if change is None or len(normalized_path) < 2:
            continue
        target = normalized_path[-1]
        if (change.id, target) in direct_targets:
            continue
        collected.append(
            DisplayImpact(
                id=f"impact-{len(direct_impacts) + len(collected) + 1}",
                change_id=change.id,
                relation="transitive",
                target_asset=target,
                operation=OperationKind.UNKNOWN,
                reason=ImpactReasonCode.UPSTREAM_FAILURE,
                evidence_level="lineage",
                path=normalized_path,
                remediation=RemediationKind.RESTORE_CONTRACT,
            )
        )
    return collected


def _collect_edges(edges: list[LineageEdge], impacts: list[DisplayImpact]) -> list[DisplayEdge]:
    required_pairs = {
        (source, target)
        for impact in impacts
        for source, target in zip(impact.path, impact.path[1:], strict=False)
    }
    grouped: dict[tuple[str, str], list[LineageEdge]] = defaultdict(list)
    for edge in edges:
        key = (edge.source_table.lower(), edge.target_table.lower())
        if key in required_pairs:
            grouped[key].append(edge)

    result: list[DisplayEdge] = []
    for source, target in sorted(required_pairs):
        candidates = grouped.get((source, target), [])
        column_candidates = [edge for edge in candidates if edge.level == "column"]
        selected = column_candidates or candidates
        source_columns = sorted({edge.source_column for edge in selected if edge.source_column})
        target_columns = sorted({edge.target_column for edge in selected if edge.target_column})
        origins = sorted({edge.origin.value for edge in selected}) or ["proposed_code"]
        observed = sorted({edge.event_time for edge in selected if edge.event_time})
        result.append(
            DisplayEdge(
                id=f"edge-{len(result) + 1}",
                source_asset=source,
                target_asset=target,
                source_column=source_columns[0] if len(source_columns) == 1 else None,
                target_column=target_columns[0] if len(target_columns) == 1 else None,
                level="column" if column_candidates else "table",
                origins=origins,
                last_observed_at=observed[-1] if observed else None,
            )
        )
    return result


def _messages(
    result: GuardResult,
    changes: list[DisplayChange],
    impacts: list[DisplayImpact],
) -> tuple[str, str]:
    type_break = next(
        (
            change
            for change in changes
            if change.before_type == TypeFamily.NUMERIC and change.after_type == TypeFamily.TEXT
        ),
        None,
    )
    numeric_use = next(
        (
            impact
            for impact in impacts
            if impact.operation == OperationKind.ARITHMETIC
            and (type_break is None or impact.target_asset != type_break.asset)
        ),
        next(
            (
                impact
                for impact in impacts
                if impact.operation
                in {
                    OperationKind.ARITHMETIC,
                    OperationKind.AGGREGATE,
                    OperationKind.CONSTRAINT,
                }
            ),
            None,
        ),
    )
    if type_break is not None and numeric_use is not None:
        target = numeric_use.target_asset.rsplit(".", maxsplit=1)[-1]
        return (
            f"{type_break.column} is now text, but {target} still performs numeric arithmetic.",
            "Keep the source column numeric and add currency formatting in a separate "
            "presentation column or layer.",
        )
    if changes and impacts:
        return (
            f"{changes[0].column} changes a contract used by verified downstream consumers.",
            "Restore the previous contract or update every verified consumer before merging.",
        )
    return _empty_evidence(result).headline, _empty_evidence(result).recommended_action


def _reason_and_remediation(
    change: DisplayChange,
    operation: OperationKind,
) -> tuple[ImpactReasonCode, RemediationKind]:
    if change.change_kind == "deleted":
        return ImpactReasonCode.MISSING_COLUMN, RemediationKind.RESTORE_CONTRACT
    if change.change_kind == "renamed":
        return ImpactReasonCode.RENAMED_COLUMN, RemediationKind.ADD_COMPATIBILITY_COLUMN
    if (
        change.before_type == TypeFamily.NUMERIC
        and change.after_type == TypeFamily.TEXT
        and operation
        in {
            OperationKind.ARITHMETIC,
            OperationKind.AGGREGATE,
            OperationKind.COMPARISON,
            OperationKind.CONSTRAINT,
        }
    ):
        return ImpactReasonCode.INCOMPATIBLE_TYPE, RemediationKind.RESTORE_CONTRACT
    if operation not in {OperationKind.PASS_THROUGH, OperationKind.UNKNOWN}:
        return ImpactReasonCode.INCOMPATIBLE_OPERATION, RemediationKind.UPDATE_CONSUMERS
    return ImpactReasonCode.SEMANTIC_CHANGE, RemediationKind.ADD_COMPATIBILITY_COLUMN


def _type_family(expression: str | None) -> TypeFamily:
    if expression is None:
        return TypeFamily.UNKNOWN
    normalized = expression.upper().strip()
    if normalized.startswith("CONCAT(") or normalized.startswith("FORMAT_NUMBER("):
        return TypeFamily.TEXT
    cast = re.match(r"^CAST\(.+\s+AS\s+([A-Z_]+)", normalized, flags=re.DOTALL)
    if cast:
        target = cast.group(1)
        if target in {
            "DECIMAL",
            "NUMERIC",
            "INT",
            "INTEGER",
            "BIGINT",
            "SMALLINT",
            "FLOAT",
            "DOUBLE",
            "REAL",
        }:
            return TypeFamily.NUMERIC
        if target in {"STRING", "VARCHAR", "CHAR"}:
            return TypeFamily.TEXT
        if target == "DATE":
            return TypeFamily.DATE
        if target.startswith("TIMESTAMP"):
            return TypeFamily.TIMESTAMP
        if target in {"BOOLEAN", "BOOL"}:
            return TypeFamily.BOOLEAN
        if target in {"ARRAY", "MAP", "STRUCT"}:
            return TypeFamily.COMPLEX
    if normalized.startswith("'") or normalized.startswith('"'):
        return TypeFamily.TEXT
    return TypeFamily.UNKNOWN


def _operation(expression: str, changed_column: str) -> OperationKind:
    normalized = expression.upper()
    reference = re.escape(changed_column.upper())
    if re.fullmatch(rf"(?:[A-Z_][A-Z0-9_]*\.)?{reference}", normalized.strip()):
        return OperationKind.PASS_THROUGH
    if re.search(r"\b(SUM|AVG|MIN|MAX)\s*\(", normalized):
        return OperationKind.AGGREGATE
    if re.search(r"[+*/]", normalized) or re.search(r"\s-\s", normalized):
        return OperationKind.ARITHMETIC
    if re.search(r"(?:=|<>|!=|<=|>=|<|>)", normalized):
        return OperationKind.COMPARISON
    if normalized.startswith("CAST("):
        return OperationKind.CAST
    return OperationKind.UNKNOWN


def _references_column(expression: str, column: str) -> bool:
    return (
        re.search(
            rf"(?<![A-Za-z0-9_]){re.escape(column)}(?![A-Za-z0-9_])",
            expression,
            re.IGNORECASE,
        )
        is not None
    )


def _column_name(value: str) -> str:
    return value.rsplit(".", maxsplit=1)[-1].lower()
