import json
from types import SimpleNamespace

from lineage_guard.ai import AIGatewayAssessor
from lineage_guard.models import ModelAssessment

VALID = {
    "decision": "pass",
    "severity": "none",
    "confidence": 0.99,
    "summary": "No breaking contract change.",
    "impacts": [],
}


def response(content: str) -> SimpleNamespace:
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


class FakeCompletions:
    def __init__(self, values: list[object]) -> None:
        self.values = values
        self.calls = 0

    def create(self, **_: object) -> SimpleNamespace:
        value = self.values[self.calls]
        self.calls += 1
        if isinstance(value, Exception):
            raise value
        return response(str(value))


def client(values: list[object]) -> tuple[SimpleNamespace, FakeCompletions]:
    completions = FakeCompletions(values)
    return SimpleNamespace(chat=SimpleNamespace(completions=completions)), completions


def test_retries_malformed_structured_output_once() -> None:
    fake_client, completions = client(["not json", json.dumps(VALID)])
    result = AIGatewayAssessor("endpoint", client=fake_client).assess({"evidence": []})
    assert result.decision.value == "pass"
    assert completions.calls == 2


def test_retries_transient_gateway_failure_three_times(
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    transient = RuntimeError("rate limited")
    transient.status_code = 429  # type: ignore[attr-defined]
    fake_client, completions = client([transient, transient, transient, json.dumps(VALID)])
    monkeypatch.setattr("lineage_guard.ai.time.sleep", lambda _: None)
    result = AIGatewayAssessor("endpoint", client=fake_client).assess({"evidence": []})
    assert result.severity.value == "none"
    assert completions.calls == 4


def test_structured_output_schema_rejects_nested_extra_fields() -> None:
    schema = ModelAssessment.model_json_schema()
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert schema["$defs"]["Impact"]["additionalProperties"] is False
    assert set(schema["$defs"]["Impact"]["required"]) == set(
        schema["$defs"]["Impact"]["properties"]
    )
