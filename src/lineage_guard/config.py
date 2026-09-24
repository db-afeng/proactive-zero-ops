from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

FQN_PATTERN = re.compile(r"^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$")
LiteralVersion = Literal[1]


class DatasetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: str
    layer: Literal["bronze", "silver", "gold"]

    @field_validator("table")
    @classmethod
    def valid_fqn(cls, value: str) -> str:
        if not FQN_PATTERN.fullmatch(value):
            raise ValueError("table must be a three-part Unity Catalog name")
        return value.lower()


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    governed_roots: list[str] = Field(min_length=1)
    lineage_lookback_days: int = Field(default=30, ge=1, le=365)
    max_lineage_depth: int = Field(default=5, ge=1, le=20)
    block_confidence: float = Field(default=0.8, ge=0, le=1)
    max_context_characters: int = Field(default=60000, ge=1000, le=500000)


class GuardConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: LiteralVersion
    settings: Settings
    datasets: dict[str, DatasetConfig]

    @field_validator("datasets")
    @classmethod
    def normalized_paths(cls, value: dict[str, DatasetConfig]) -> dict[str, DatasetConfig]:
        for path in value:
            candidate = Path(path)
            if candidate.is_absolute() or ".." in candidate.parts:
                raise ValueError(f"dataset path must be repository-relative: {path}")
        return value

    @model_validator(mode="after")
    def unique_dataset_tables(self) -> GuardConfig:
        tables = [dataset.table for dataset in self.datasets.values()]
        if len(tables) != len(set(tables)):
            raise ValueError("each governed SQL file must map to a unique Unity Catalog table")
        return self

    @property
    def tables_to_paths(self) -> dict[str, str]:
        return {dataset.table: path for path, dataset in self.datasets.items()}


def load_config(path: Path) -> GuardConfig:
    with path.open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)
    return GuardConfig.model_validate(raw)
