"""Trusted disclosure boundaries for lineage-guard assessment evidence.

GitHub is a shared reporting surface: comments, job summaries, logs, and
downloadable workflow artifacts may be visible to people who are not allowed
to inspect the affected data assets.  This module therefore projects an
assessment into a deliberately small public shape.  It never copies model
summaries, errors, SQL, file names, asset metadata, or lineage evidence into
that shape.

The detailed envelope returned by :func:`prepare_disclosures` is classified as
restricted.  Callers must store it only in a service which authenticates each
viewer and checks their permission to view the evidence.  In particular, it
must not be uploaded as a GitHub Actions artifact.  GitHub OIDC authenticates
the assessment service principal; it is not user delegation or OBO.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import stat
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Any, Literal

PUBLIC_SCHEMA_VERSION = 1
PUBLIC_MARKER = "<!-- proactive-zero-ops-lineage-guard -->"

# This is enforcement policy in trusted base-branch code.  It is intentionally
# not loaded from bundle or pull-request configuration.
_PUBLIC_MESSAGES: Mapping[str, str] = MappingProxyType(
    {
        "pass": "No blocking downstream impact was identified.",
        "warn": "The assessment completed with a non-blocking warning.",
        "block": "A potentially breaking downstream impact was identified.",
        "error": "The assessment could not be completed safely.",
    }
)
_REFERENCE_PATTERN = re.compile(r"^lgr_[A-Za-z0-9_-]{32}$")


class PublicOutcome(StrEnum):
    """The only assessment property approved for public disclosure."""

    PASS = "pass"
    WARN = "warn"
    BLOCK = "block"
    ERROR = "error"


@dataclass(frozen=True)
class AssessmentReference:
    """A random, opaque reference shared by public and restricted records.

    A reference contains 192 bits of randomness.  It is stable when the same
    instance is used to render multiple surfaces, but cannot be derived from
    the evidence and therefore discloses nothing about it.
    """

    value: str

    def __post_init__(self) -> None:
        if not _REFERENCE_PATTERN.fullmatch(self.value):
            raise ValueError("assessment reference must be an opaque lineage-guard reference")

    @classmethod
    def generate(cls) -> AssessmentReference:
        return cls(f"lgr_{secrets.token_urlsafe(24)}")

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True)
class PublicDisclosure:
    """The complete allowlisted representation for any public surface."""

    reference: AssessmentReference
    outcome: PublicOutcome
    message: str = field(init=False)
    schema_version: Literal[1] = field(default=PUBLIC_SCHEMA_VERSION, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "message", _PUBLIC_MESSAGES[self.outcome.value])

    def as_dict(self) -> dict[str, str | int]:
        # Keep this explicit allowlist.  Do not serialize ``__dict__`` or merge
        # arbitrary assessment metadata here.
        return {
            "schema_version": self.schema_version,
            "assessment_reference": self.reference.value,
            "outcome": self.outcome.value,
            "message": self.message,
        }


@dataclass(frozen=True)
class RestrictedEvidence:
    """Full evidence destined only for an authenticated, authorized store."""

    reference: AssessmentReference
    evidence: Any = field(repr=False)
    classification: Literal["restricted"] = field(default="restricted", init=False)
    authentication: Literal["required"] = field(default="required", init=False)
    viewer_authorization: Literal["required"] = field(default="required", init=False)
    assessment_principal: Literal["service_principal"] = field(
        default="service_principal", init=False
    )

    def __repr__(self) -> str:
        return (
            "RestrictedEvidence("
            f"reference={self.reference!r}, classification='restricted', "
            "authentication='required', viewer_authorization='required', "
            "assessment_principal='service_principal', evidence=<redacted>)"
        )

    def to_authenticated_record(self) -> dict[str, Any]:
        """Return the record for an authenticated evidence store.

        The caller owns the permission check and storage transport.  This
        method is deliberately not used by any public rendering function.
        """

        return {
            "schema_version": PUBLIC_SCHEMA_VERSION,
            "assessment_reference": self.reference.value,
            "classification": self.classification,
            "authentication": self.authentication,
            "viewer_authorization": self.viewer_authorization,
            "assessment_principal": self.assessment_principal,
            "evidence": _jsonable(self.evidence),
        }


@dataclass(frozen=True)
class DisclosureSet:
    """Paired public projection and restricted evidence for one assessment."""

    public: PublicDisclosure
    restricted: RestrictedEvidence = field(repr=False)

    def __repr__(self) -> str:
        return f"DisclosureSet(public={self.public!r}, restricted=<redacted>)"


class RestrictedEvidenceStore:
    """Owner-only local evidence storage for the v1 service-principal flow.

    The root directory is forced to mode ``0700`` and records are atomically
    installed with mode ``0600``.  On a dedicated self-hosted runner, the OS
    account is the authentication and authorization boundary.  Deployments
    that need evidence access for multiple human viewers must replace this
    store with a backend that authenticates each viewer and authorizes the
    requested reference; publishing these records to GitHub is never valid.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self._prepare_root()

    def write(self, restricted: RestrictedEvidence) -> AssessmentReference:
        """Atomically persist one restricted record and return its opaque ID."""

        payload = (
            json.dumps(
                restricted.to_authenticated_record(),
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode()
        target = self._record_path(restricted.reference)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".lineage-guard-",
            suffix=".tmp",
            dir=self.root,
        )
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = -1
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            os.chmod(target, 0o600, follow_symlinks=False)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
        return restricted.reference

    def read(self, reference: AssessmentReference) -> dict[str, Any]:
        """Read a record after verifying that its owner-only mode remains set."""

        target = self._record_path(reference)
        metadata = target.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise PermissionError("restricted evidence record must be a regular file")
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise PermissionError("restricted evidence record must have mode 0600")
        record = json.loads(target.read_text())
        if not isinstance(record, dict):
            raise ValueError("restricted evidence record must be a JSON object")
        return record

    def _prepare_root(self) -> None:
        if self.root.is_symlink():
            raise ValueError("restricted evidence directory must not be a symbolic link")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = self.root.lstat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("restricted evidence root must be a directory")
        os.chmod(self.root, 0o700, follow_symlinks=False)

    def _record_path(self, reference: AssessmentReference) -> Path:
        # The validated opaque reference contains no path separators.
        return self.root / f"{reference.value}.json"


def prepare_disclosures(
    *,
    status: str,
    evidence: Any,
    reference: AssessmentReference | None = None,
) -> DisclosureSet:
    """Split an assessment into fixed public output and restricted evidence.

    Unknown status values fail closed to the public ``error`` outcome.  No
    value from ``evidence`` is inspected while creating the public projection.
    """

    assessment_reference = reference or AssessmentReference.generate()
    try:
        outcome = PublicOutcome(status)
    except ValueError:
        outcome = PublicOutcome.ERROR

    return DisclosureSet(
        public=PublicDisclosure(reference=assessment_reference, outcome=outcome),
        restricted=RestrictedEvidence(
            reference=assessment_reference,
            evidence=evidence,
        ),
    )


def render_public_markdown(disclosure: PublicDisclosure) -> str:
    """Render the approved public content for comments and job summaries."""

    icons = {
        PublicOutcome.PASS: "✅",
        PublicOutcome.WARN: "⚠️",
        PublicOutcome.BLOCK: "⛔",
        PublicOutcome.ERROR: "❌",
    }
    return "\n".join(
        [
            PUBLIC_MARKER,
            "## Downstream impact assessment",
            "",
            f"{icons[disclosure.outcome]} **{disclosure.outcome.value.upper()}**",
            "",
            disclosure.message,
            "",
            f"Assessment reference: `{disclosure.reference.value}`",
            "",
            ("_Detailed evidence is restricted and requires authenticated, authorized access._"),
            "",
        ]
    )


def render_public_log(disclosure: PublicDisclosure) -> str:
    """Render a single safe log line with no assessment evidence."""

    return (
        "lineage-guard "
        f"outcome={disclosure.outcome.value} "
        f"assessment_reference={disclosure.reference.value}"
    )


def serialize_public_artifact(disclosure: PublicDisclosure) -> bytes:
    """Create the only payload suitable for a downloadable GitHub artifact."""

    return (json.dumps(disclosure.as_dict(), sort_keys=True, separators=(",", ":")) + "\n").encode()


def _jsonable(value: Any) -> Any:
    """Convert common evidence containers without changing public output."""

    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    raise TypeError(f"restricted evidence contains unsupported type: {type(value).__name__}")
