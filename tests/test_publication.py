from __future__ import annotations

import io
from types import SimpleNamespace

import pytest
from databricks.sdk.errors.platform import ResourceAlreadyExists

from lineage_guard.disclosure import (
    AssessmentReference,
    AssessmentSource,
    RestrictedEvidenceStore,
    prepare_disclosures,
    serialize_public_artifact,
)
from lineage_guard.publication import (
    PublicationConflict,
    publish_restricted_evidence,
    reference_from_public_artifact,
    validate_publication_receipt,
    validate_volume_root,
    write_private_publication_receipt,
)

REFERENCE = AssessmentReference("lgr_0123456789abcdefghijklmnopqrstuv")
SOURCE = AssessmentSource(
    repository="db-afeng/proactive-zero-ops",
    pull_request_number=4,
    base_sha="a" * 40,
    head_sha="b" * 40,
)
VOLUME = "/Volumes/proactive_zero_ops_catalog/proactive_zero_ops_guard/restricted_assessments"


class FakeFiles:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.uploads: list[tuple[str, bool | None]] = []

    def upload(
        self,
        file_path: str,
        contents: io.BytesIO,
        *,
        overwrite: bool | None = None,
    ) -> None:
        self.uploads.append((file_path, overwrite))
        if file_path in self.objects:
            raise ResourceAlreadyExists("exists", error_code="RESOURCE_ALREADY_EXISTS")
        self.objects[file_path] = contents.read()

    def download(self, file_path: str) -> SimpleNamespace:
        return SimpleNamespace(contents=io.BytesIO(self.objects[file_path]))


def staged_store(tmp_path) -> tuple[RestrictedEvidenceStore, bytes]:
    disclosure = prepare_disclosures(
        status="block",
        evidence={"asset": "catalog.schema.table"},
        source=SOURCE,
        reference=REFERENCE,
        created_at="2026-09-28T10:00:00Z",
    )
    store = RestrictedEvidenceStore(tmp_path / "restricted")
    store.write(disclosure.restricted)
    return store, serialize_public_artifact(disclosure.public)


def test_publish_is_immutable_and_identical_retry_is_idempotent(tmp_path) -> None:
    store, _ = staged_store(tmp_path)
    files = FakeFiles()

    first = publish_restricted_evidence(
        store=store,
        reference=REFERENCE,
        volume_root=VOLUME,
        files=files,
    )
    second = publish_restricted_evidence(
        store=store,
        reference=REFERENCE,
        volume_root=VOLUME,
        files=files,
    )

    assert first.created is True
    assert second.created is False
    assert first.volume_path == f"{VOLUME}/{REFERENCE.value}.json"
    assert first.content_sha256 == second.content_sha256
    assert files.uploads == [(first.volume_path, False), (first.volume_path, False)]


def test_publish_refuses_to_rebind_reference_to_different_bytes(tmp_path) -> None:
    store, _ = staged_store(tmp_path)
    files = FakeFiles()
    target = f"{VOLUME}/{REFERENCE.value}.json"
    files.objects[target] = b'{"different":"evidence"}\n'

    with pytest.raises(PublicationConflict, match="different restricted evidence"):
        publish_restricted_evidence(
            store=store,
            reference=REFERENCE,
            volume_root=VOLUME,
            files=files,
        )


@pytest.mark.parametrize(
    "value",
    [
        "dbfs:/Volumes/catalog/schema/volume",
        "/Volumes/catalog/schema",
        "/Volumes/catalog/schema/volume/subdirectory",
        "/Volumes/catalog/schema/../other",
        "/Volumes/catalog//schema/volume",
        "/Volumes/catalog/schema/volume/",
    ],
)
def test_volume_root_rejects_noncanonical_or_overbroad_paths(value: str) -> None:
    with pytest.raises(ValueError, match="Volume"):
        validate_volume_root(value)


def test_reference_is_read_only_from_exact_public_schema(tmp_path) -> None:
    _, public = staged_store(tmp_path)
    assert reference_from_public_artifact(public) == REFERENCE

    with pytest.raises(ValueError, match="schema"):
        reference_from_public_artifact(
            public.rstrip()[:-1] + b',"sensitive":"catalog.schema.table"}'
        )


def test_private_receipt_must_match_public_reference_and_volume(tmp_path) -> None:
    store, _ = staged_store(tmp_path)
    result = publish_restricted_evidence(
        store=store,
        reference=REFERENCE,
        volume_root=VOLUME,
        files=FakeFiles(),
    )
    receipt = tmp_path / "private" / "receipt.json"
    write_private_publication_receipt(result, receipt)
    validate_publication_receipt(
        receipt.read_bytes(),
        reference=REFERENCE,
        volume_root=VOLUME,
    )
    assert receipt.stat().st_mode & 0o777 == 0o600

    wrong = AssessmentReference("lgr_zyxwvutsrqponmlkjihgfedcba987654")
    with pytest.raises(ValueError, match="does not match"):
        validate_publication_receipt(
            receipt.read_bytes(),
            reference=wrong,
            volume_root=VOLUME,
        )
