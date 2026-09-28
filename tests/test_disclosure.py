import json
import re
import stat

import pytest

from lineage_guard.disclosure import (
    AssessmentReference,
    PublicOutcome,
    RestrictedEvidenceStore,
    prepare_disclosures,
    render_public_log,
    render_public_markdown,
    serialize_public_artifact,
)

REFERENCE = AssessmentReference("lgr_0123456789abcdefghijklmnopqrstuv")


def sensitive_evidence() -> dict[str, object]:
    return {
        "summary": "SENSITIVE_MODEL_SUMMARY",
        "error": "SENSITIVE_WAREHOUSE_FAILURE",
        "changed_files": ["SENSITIVE_SOURCE_PATH.sql"],
        "changed_sql": "SELECT SENSITIVE_EXPRESSION FROM secret",
        "assets": [
            {
                "id": "SENSITIVE_ASSET_ID",
                "owner": "SENSITIVE_OWNER",
                "table": "SENSITIVE_CATALOG.SENSITIVE_SCHEMA.SENSITIVE_TABLE",
            }
        ],
        "lineage_paths": [["SENSITIVE_SOURCE_DATASET", "SENSITIVE_DOWNSTREAM_DATASET"]],
        "warnings": ["SENSITIVE_DISCOVERY_LIMITATION"],
    }


def public_representations(status: str = "block") -> list[str]:
    disclosures = prepare_disclosures(
        status=status,
        evidence=sensitive_evidence(),
        reference=REFERENCE,
    )
    return [
        repr(disclosures),
        repr(disclosures.public),
        json.dumps(disclosures.public.as_dict()),
        render_public_markdown(disclosures.public),
        render_public_log(disclosures.public),
        serialize_public_artifact(disclosures.public).decode(),
    ]


@pytest.mark.parametrize("status", ["pass", "warn", "block", "error"])
def test_every_public_surface_uses_only_allowlisted_fields(status: str) -> None:
    for representation in public_representations(status):
        upper = representation.upper()
        assert "SENSITIVE" not in upper
        assert "LINEAGE_PATH" not in upper
        assert "CHANGED_SQL" not in upper
        assert "OWNER" not in upper


def test_public_artifact_has_a_strict_schema() -> None:
    disclosures = prepare_disclosures(
        status="block",
        evidence=sensitive_evidence(),
        reference=REFERENCE,
    )
    artifact = json.loads(serialize_public_artifact(disclosures.public))
    assert artifact == {
        "assessment_reference": REFERENCE.value,
        "message": "A potentially breaking downstream impact was identified.",
        "outcome": "block",
        "schema_version": 1,
    }


def test_error_details_are_never_copied_to_public_output() -> None:
    combined = "\n".join(public_representations("error"))
    assert "SENSITIVE_WAREHOUSE_FAILURE" not in combined
    assert "could not be completed safely" in combined


def test_unknown_status_fails_closed_without_echoing_it() -> None:
    malicious_status = "SENSITIVE_UNKNOWN_STATUS"
    disclosures = prepare_disclosures(
        status=malicious_status,
        evidence=sensitive_evidence(),
        reference=REFERENCE,
    )
    assert disclosures.public.outcome is PublicOutcome.ERROR
    assert malicious_status not in render_public_markdown(disclosures.public)
    assert malicious_status not in serialize_public_artifact(disclosures.public).decode()


def test_restricted_evidence_is_separate_and_repr_is_redacted() -> None:
    disclosures = prepare_disclosures(
        status="warn",
        evidence=sensitive_evidence(),
        reference=REFERENCE,
    )
    restricted = disclosures.restricted
    assert restricted.to_authenticated_record()["evidence"] == sensitive_evidence()
    assert restricted.to_authenticated_record()["classification"] == "restricted"
    assert restricted.to_authenticated_record()["authentication"] == "required"
    assert restricted.to_authenticated_record()["viewer_authorization"] == "required"
    assert restricted.to_authenticated_record()["assessment_principal"] == "service_principal"
    assert "SENSITIVE" not in repr(restricted)
    assert "SENSITIVE" not in repr(disclosures)


def test_generated_references_are_random_opaque_and_reusable() -> None:
    first = AssessmentReference.generate()
    second = AssessmentReference.generate()
    assert first != second
    assert re.fullmatch(r"lgr_[A-Za-z0-9_-]{32}", first.value)

    disclosures = prepare_disclosures(
        status="pass",
        evidence=sensitive_evidence(),
        reference=first,
    )
    assert first.value in render_public_markdown(disclosures.public)
    assert first.value in render_public_log(disclosures.public)
    assert first.value in serialize_public_artifact(disclosures.public).decode()


@pytest.mark.parametrize(
    "value",
    [
        "",
        "lgr_too-short",
        "lgr_0123456789abcdefghijklmnopqrstu/",
        "SENSITIVE_ASSET_ID",
    ],
)
def test_reference_validation_rejects_nonopaque_values(value: str) -> None:
    with pytest.raises(ValueError, match="opaque"):
        AssessmentReference(value)


def test_public_projection_is_deterministic_for_same_status_and_reference() -> None:
    first = prepare_disclosures(
        status="block", evidence={"secret": "one"}, reference=REFERENCE
    ).public
    second = prepare_disclosures(
        status="block", evidence={"secret": "two"}, reference=REFERENCE
    ).public
    assert first == second
    assert render_public_markdown(first) == render_public_markdown(second)
    assert serialize_public_artifact(first) == serialize_public_artifact(second)


def test_restricted_store_uses_private_modes_and_atomic_replacement(tmp_path) -> None:
    root = tmp_path / "restricted-evidence"
    store = RestrictedEvidenceStore(root)
    first = prepare_disclosures(status="block", evidence={"secret": "first"}, reference=REFERENCE)
    assert store.write(first.restricted) == REFERENCE

    target = root / f"{REFERENCE.value}.json"
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert store.read(REFERENCE)["evidence"] == {"secret": "first"}
    assert not list(root.glob("*.tmp"))

    second = prepare_disclosures(status="warn", evidence={"secret": "second"}, reference=REFERENCE)
    store.write(second.restricted)
    assert store.read(REFERENCE)["evidence"] == {"secret": "second"}
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert not list(root.glob("*.tmp"))


def test_restricted_store_refuses_records_with_broadened_permissions(tmp_path) -> None:
    store = RestrictedEvidenceStore(tmp_path / "restricted-evidence")
    disclosures = prepare_disclosures(
        status="error", evidence=sensitive_evidence(), reference=REFERENCE
    )
    store.write(disclosures.restricted)
    target = store.root / f"{REFERENCE.value}.json"
    target.chmod(0o644)

    with pytest.raises(PermissionError, match="0600"):
        store.read(REFERENCE)


def test_restricted_store_refuses_symbolic_link_root(tmp_path) -> None:
    actual = tmp_path / "actual"
    actual.mkdir()
    link = tmp_path / "linked"
    link.symlink_to(actual, target_is_directory=True)

    with pytest.raises(ValueError, match="symbolic link"):
        RestrictedEvidenceStore(link)


def test_restricted_serialization_failure_writes_nothing(tmp_path) -> None:
    store = RestrictedEvidenceStore(tmp_path / "restricted-evidence")
    disclosures = prepare_disclosures(
        status="error", evidence={"unsupported": object()}, reference=REFERENCE
    )

    with pytest.raises(TypeError, match="unsupported type"):
        store.write(disclosures.restricted)
    assert not list(store.root.iterdir())
