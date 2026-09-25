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


class LineageEdge(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_table: str
    target_table: str
    source_column: str | None = None
    target_column: str | None = None
    target_type: str = "TABLE"
    level: Literal["column", "table"]
    event_time: str | None = None

    @property
    def key(self) -> tuple[str, str, str | None, str | None, str]:
        return (
            self.source_table,
            self.target_table,
            self.source_column,
            self.target_column,
            self.level,
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
    # AI Gateway strict JSON schemas require every property to be listed in
    # ``required``. The model must therefore emit empty arrays explicitly for
    # safe changes rather than relying on Pydantic defaults.
    changed_columns: list[ChangedColumn]
    impacts: list[Impact]


class GuardResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["pass", "warn", "block", "error"]
    severity: Severity = Severity.NONE
    confidence: float = Field(default=0, ge=0, le=1)
    summary: str
    changed_files: list[str] = Field(default_factory=list)
    changed_columns: list[ChangedColumn] = Field(default_factory=list)
    impacts: list[Impact] = Field(default_factory=list)
    lineage_edges: list[LineageEdge] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None

    @property
    def exit_code(self) -> int:
        return {"pass": 0, "warn": 0, "block": 1, "error": 2}[self.status]
