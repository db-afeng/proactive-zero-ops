"""Immutable publication of restricted assessment envelopes to a UC Volume."""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Protocol

from databricks.sdk.errors.platform import ResourceAlreadyExists

from lineage_guard.disclosure import AssessmentReference, RestrictedEvidenceStore

DEFAULT_RESTRICTED_VOLUME_ROOT = (
    "/Volumes/proactive_zero_ops_catalog/proactive_zero_ops_guard/restricted_assessments"
)

_UC_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$")


class _DownloadResponse(Protocol):
    contents: BinaryIO


class FilesApi(Protocol):
    """The small Workspace Files API surface used by the publisher."""

    def upload(
        self,
        file_path: str,
        contents: BinaryIO,
        *,
        overwrite: bool | None = None,
    ) -> None: ...

    def download(self, file_path: str) -> _DownloadResponse: ...


@dataclass(frozen=True)
class PublicationResult:
    reference: AssessmentReference
    volume_path: str
    content_sha256: str
    created: bool


class PublicationConflict(RuntimeError):
    """An immutable reference already exists with different evidence."""


def publish_restricted_evidence(
    *,
    store: RestrictedEvidenceStore,
    reference: AssessmentReference,
    volume_root: str,
    files: FilesApi,
) -> PublicationResult:
    """Publish one validated record without ever overwriting an existing object.

    The opaque reference makes the target unique. A retry is accepted only when
    the existing bytes are identical, which makes workflow retries idempotent
    without allowing a reference to be rebound to different evidence.
    """

    root = validate_volume_root(volume_root)
    payload = store.serialized_record(reference)
    target = f"{root}/{reference.value}.json"

    try:
        files.upload(target, io.BytesIO(payload), overwrite=False)
        created = True
    except ResourceAlreadyExists:
        response = files.download(target)
        try:
            existing = response.contents.read()
        finally:
            response.contents.close()
        if not hmac.compare_digest(_digest(existing), _digest(payload)):
            raise PublicationConflict(
                "assessment reference already exists with different restricted evidence"
            ) from None
        created = False

    return PublicationResult(
        reference=reference,
        volume_path=target,
        content_sha256=hashlib.sha256(payload).hexdigest(),
        created=created,
    )


def write_private_publication_receipt(
    result: PublicationResult,
    destination: Path,
) -> None:
    """Persist a private, strict receipt only after the Volume write succeeds."""

    destination = destination.resolve()
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = (
        json.dumps(
            {
                "schema_version": 1,
                "assessment_reference": result.reference.value,
                "volume_path": result.volume_path,
                "content_sha256": result.content_sha256,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode()
    descriptor, temporary = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
    )
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def validate_publication_receipt(
    payload: bytes | str,
    *,
    reference: AssessmentReference,
    volume_root: str,
) -> None:
    """Require an exact receipt bound to the public reference and target path."""

    try:
        document = json.loads(payload)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid publication receipt") from exc
    required = {
        "schema_version",
        "assessment_reference",
        "volume_path",
        "content_sha256",
    }
    target = f"{validate_volume_root(volume_root)}/{reference.value}.json"
    if (
        not isinstance(document, dict)
        or set(document) != required
        or document.get("schema_version") != 1
        or document.get("assessment_reference") != reference.value
        or document.get("volume_path") != target
        or re.fullmatch(r"[0-9a-f]{64}", str(document.get("content_sha256"))) is None
    ):
        raise ValueError("publication receipt does not match the public assessment")


def reference_from_public_artifact(payload: bytes | str) -> AssessmentReference:
    """Extract a reference only from the exact minimal public artifact schema."""

    from lineage_guard.disclosure import deserialize_public_artifact

    return deserialize_public_artifact(payload).reference


def validate_volume_root(value: str) -> str:
    """Require an exact three-level UC Volume root, not an arbitrary file path."""

    if not isinstance(value, str) or value != value.strip() or "//" in value:
        raise ValueError("restricted evidence destination must be a Unity Catalog Volume root")
    normalized = str(PurePosixPath(value))
    parts = PurePosixPath(value).parts
    if normalized != value or len(parts) != 5 or parts[:2] != ("/", "Volumes"):
        raise ValueError("restricted evidence destination must be /Volumes/catalog/schema/volume")
    if not all(_UC_NAME.fullmatch(part) for part in parts[2:]):
        raise ValueError("restricted evidence Volume names contain unsupported characters")
    return normalized


def _digest(value: bytes) -> bytes:
    return hashlib.sha256(value).digest()
