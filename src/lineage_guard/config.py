from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field


class Settings(BaseModel):
    """The deliberately small, trusted checker configuration surface.

    Dataset identities and source roots are discovered from the bundle at each
    Git revision. Enforcement thresholds, disclosure rules, and connection
    settings are intentionally not configurable here.
    """

    model_config = ConfigDict(extra="forbid")

    max_lineage_depth: int = Field(default=5, ge=1, le=20)


class GuardConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    settings: Settings = Field(default_factory=Settings)


def load_config(path: Path | None = None) -> GuardConfig:
    """Load optional trusted settings without requiring a dataset manifest."""

    if path is None or not path.exists():
        return GuardConfig()
    with path.open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)
    return GuardConfig.model_validate(raw or {})
