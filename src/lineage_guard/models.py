from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Severity(StrEnum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class Decision(StrEnum):
    PASS = "pass"
    WARN = "warn"
    BLOCK = "block"


class EvidenceOrigin(StrEnum):
    """How a dependency was established.

    Proposed-code edges are derived from deterministic SQL parsing. Observed
    edges come from Unity Catalog system tables and describe prior executions.
    They remain separate even when they connect the same two assets.
    """

    PROPOSED_CODE = "proposed_code"
    OBSERVED_LINEAGE = "observed_lineage"


class DiscoveryCertainty(StrEnum):
    COMPLETE = "complete"
    INCOMPLETE = "incomplete"


class LineageEdge(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_table: str
    target_table: str
    source_column: str | None = None
    target_column: str | None = None
    target_type: str = "TABLE"
    level: Literal["column", "table"]
    event_time: str | None = None
    origin: EvidenceOrigin = EvidenceOrigin.OBSERVED_LINEAGE
    entity_type: str | None = None
    entity_id: str | None = None
    entity_run_id: str | None = None
    created_by: str | None = None

    @property
    def key(self) -> tuple[str, str, str | None, str | None, str, str]:
        return (
            self.source_table,
            self.target_table,
            self.source_column,
            self.target_column,
            self.level,
            self.origin.value,
        )


class ChangedColumn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: str
    column: str
    old_contract: str
    new_contract: str
    evidence: str


class Impact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset: str
    path: list[str] = Field(min_length=2)
    failure_mode: str
    evidence: str

    @field_validator("path")
    @classmethod
    def path_is_nonempty(cls, value: list[str]) -> list[str]:
        if any(not part.strip() for part in value):
            raise ValueError("lineage path elements must not be empty")
        return value


class ModelAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Decision
    severity: Severity
    confidence: float = Field(ge=0, le=1)
    summary: str
    impacts: list[Impact]


class GuardResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["pass", "warn", "block", "error"]
    severity: Severity = Severity.NONE
    confidence: float = Field(default=0, ge=0, le=1)
    summary: str
    assessment_complete: bool = True
    discovery_certainty: DiscoveryCertainty = DiscoveryCertainty.COMPLETE
    changed_files: list[str] = Field(default_factory=list)
    changed_columns: list[ChangedColumn] = Field(default_factory=list)
    impacts: list[Impact] = Field(default_factory=list)
    lineage_edges: list[LineageEdge] = Field(default_factory=list)
    semantic_changes: list[dict[str, object]] = Field(default_factory=list)
    bundle_changes: list[dict[str, object]] = Field(default_factory=list)
    coverage_limitations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None

    @property
    def exit_code(self) -> int:
        return {"pass": 0, "warn": 0, "block": 1, "error": 2}[self.status]
