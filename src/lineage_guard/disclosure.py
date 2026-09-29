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
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Any, Literal
from urllib.parse import quote, urlsplit, urlunsplit

PUBLIC_SCHEMA_VERSION = 1
RESTRICTED_SCHEMA_VERSION = 3
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
_REPOSITORY_PATTERN = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?/"
    r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$"
)
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40,64}$")


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
class AssessmentSource:
    """Trusted GitHub identity and exact revision pair for an assessment."""

    repository: str
    pull_request_number: int
    base_sha: str
    head_sha: str
    provider: Literal["github"] = field(default="github", init=False)

    def __post_init__(self) -> None:
        if not isinstance(self.repository, str) or not _REPOSITORY_PATTERN.fullmatch(
            self.repository
        ):
            raise ValueError("repository must be an owner/name GitHub repository")
        if not isinstance(self.pull_request_number, int) or self.pull_request_number < 1:
            raise ValueError("pull request number must be positive")
        if not isinstance(self.base_sha, str) or not _COMMIT_PATTERN.fullmatch(self.base_sha):
            raise ValueError("base SHA must be a full lowercase hexadecimal commit ID")
        if not isinstance(self.head_sha, str) or not _COMMIT_PATTERN.fullmatch(self.head_sha):
            raise ValueError("head SHA must be a full lowercase hexadecimal commit ID")

    def as_dict(self) -> dict[str, str | int]:
        return {
            "provider": self.provider,
            "repository": self.repository,
            "pull_request_number": self.pull_request_number,
            "base_sha": self.base_sha,
            "head_sha": self.head_sha,
        }


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
    source: AssessmentSource
    evidence: Any = field(repr=False)
    created_at: str = field(default_factory=lambda: _utc_now())
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
            "schema_version": RESTRICTED_SCHEMA_VERSION,
            "assessment_reference": self.reference.value,
            "created_at": _validate_timestamp(self.created_at),
            "source": self.source.as_dict(),
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
    """Owner-only staging storage for the restricted service-principal flow.

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
            _fsync_directory(self.root)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
        return restricted.reference

    def read(self, reference: AssessmentReference) -> dict[str, Any]:
        """Read a record after verifying that its owner-only mode remains set."""

        payload = self.serialized_record(reference)
        record = json.loads(payload)
        return record

    def serialized_record(self, reference: AssessmentReference) -> bytes:
        """Return a validated envelope exactly as it was atomically serialized."""

        payload = self.read_bytes(reference)
        record = json.loads(payload)
        _validate_restricted_record(record, expected_reference=reference)
        return payload

    def read_bytes(self, reference: AssessmentReference) -> bytes:
        """Read exact serialized bytes without following a replaced symbolic link."""

        target = self._record_path(reference)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(target, flags)
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise PermissionError("restricted evidence record must be a regular file")
            if metadata.st_uid != os.geteuid():
                raise PermissionError(
                    "restricted evidence record must be owned by the current user"
                )
            if stat.S_IMODE(metadata.st_mode) != 0o600:
                raise PermissionError("restricted evidence record must have mode 0600")
            with os.fdopen(descriptor, "rb") as handle:
                descriptor = -1
                return handle.read()
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    def _prepare_root(self) -> None:
        if self.root.is_symlink():
            raise ValueError("restricted evidence directory must not be a symbolic link")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = self.root.lstat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("restricted evidence root must be a directory")
        if metadata.st_uid != os.geteuid():
            raise PermissionError("restricted evidence root must be owned by the current user")
        os.chmod(self.root, 0o700, follow_symlinks=False)

    def _record_path(self, reference: AssessmentReference) -> Path:
        # The validated opaque reference contains no path separators.
        return self.root / f"{reference.value}.json"


def prepare_disclosures(
    *,
    status: str,
    evidence: Any,
    source: AssessmentSource,
    reference: AssessmentReference | None = None,
    created_at: str | None = None,
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
            source=source,
            evidence=evidence,
            **({"created_at": created_at} if created_at is not None else {}),
        ),
    )


def render_public_markdown(
    disclosure: PublicDisclosure,
    *,
    assessment_base_url: str | None = None,
) -> str:
    """Render the approved public content for comments and job summaries."""

    icons = {
        PublicOutcome.PASS: "✅",
        PublicOutcome.WARN: "⚠️",
        PublicOutcome.BLOCK: "⛔",
        PublicOutcome.ERROR: "❌",
    }
    lines = [
        PUBLIC_MARKER,
        "## Downstream impact assessment",
        "",
        f"{icons[disclosure.outcome]} **{disclosure.outcome.value.upper()}**",
        "",
        disclosure.message,
        "",
        f"Assessment reference: `{disclosure.reference.value}`",
        "",
    ]
    if assessment_base_url is not None:
        lines.extend(
            [
                "[Review authorized impact and propose a fix]"
                f"({_assessment_url(assessment_base_url, disclosure.reference)})",
                "",
            ]
        )
    lines.extend(
        [
            "_Detailed evidence is restricted and requires authenticated, authorized access._",
            "",
        ]
    )
    return "\n".join(lines)


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


def deserialize_public_artifact(payload: bytes | str) -> PublicDisclosure:
    """Parse only the exact allowlisted public schema."""

    record = json.loads(payload)
    if not isinstance(record, dict):
        raise ValueError("public assessment must be a JSON object")
    required = {"schema_version", "assessment_reference", "outcome", "message"}
    if set(record) != required or record.get("schema_version") != PUBLIC_SCHEMA_VERSION:
        raise ValueError("public assessment does not match schema version 1")
    try:
        disclosure = PublicDisclosure(
            reference=AssessmentReference(record["assessment_reference"]),
            outcome=PublicOutcome(record["outcome"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("public assessment contains invalid values") from exc
    if record["message"] != disclosure.message:
        raise ValueError("public assessment message is not allowlisted")
    return disclosure


def _assessment_url(base_url: str, reference: AssessmentReference) -> str:
    if base_url != base_url.strip():
        raise ValueError("assessment app URL must not contain surrounding whitespace")
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("assessment app URL must be an HTTPS URL without credentials or query")
    path = parsed.path.rstrip("/") + "/assessments/" + quote(reference.value, safe="")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _validate_timestamp(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("restricted evidence timestamp must be RFC 3339")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError("restricted evidence timestamp must be RFC 3339") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("restricted evidence timestamp must include a timezone")
    return value


def _validate_restricted_record(
    record: Any,
    *,
    expected_reference: AssessmentReference,
) -> None:
    required = {
        "schema_version",
        "assessment_reference",
        "created_at",
        "source",
        "classification",
        "authentication",
        "viewer_authorization",
        "assessment_principal",
        "evidence",
    }
    if not isinstance(record, dict) or set(record) != required:
        raise ValueError("restricted evidence record does not match the versioned envelope")
    if record["schema_version"] != RESTRICTED_SCHEMA_VERSION:
        raise ValueError("restricted evidence schema version is unsupported")
    if record["assessment_reference"] != expected_reference.value:
        raise ValueError("restricted evidence reference does not match its file name")
    if record["classification"] != "restricted":
        raise ValueError("restricted evidence classification is invalid")
    if record["authentication"] != "required" or record["viewer_authorization"] != "required":
        raise ValueError("restricted evidence authorization policy is invalid")
    if record["assessment_principal"] != "service_principal":
        raise ValueError("restricted evidence assessment principal is invalid")
    _validate_timestamp(record["created_at"])
    source = record["source"]
    if not isinstance(source, dict) or set(source) != {
        "provider",
        "repository",
        "pull_request_number",
        "base_sha",
        "head_sha",
    }:
        raise ValueError("restricted evidence source metadata is invalid")
    if source.get("provider") != "github":
        raise ValueError("restricted evidence source provider is invalid")
    AssessmentSource(
        repository=source.get("repository"),
        pull_request_number=source.get("pull_request_number"),
        base_sha=source.get("base_sha"),
        head_sha=source.get("head_sha"),
    )


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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
