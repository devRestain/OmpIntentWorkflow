"""Check fixture structure and demonstrate that structure is not semantics.

No OMP process, Git repository, provider, local model, or natural-language
interpreter is executed. Expected invariants in cases.jsonl are manual test
specifications, not observed outcomes. The steering trace is hypothetical.

Run with Python's standard library:
    python3 omp-workflow-v3/eval/validate_fixtures.py
"""

import copy
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_index(items, key="id"):
    result = {item[key]: item for item in items}
    require(len(result) == len(items), f"Duplicate {key} in fixture")
    return result


def validate_sources(trace):
    require(trace["example_only"] is True, "Examples must be illustrative")
    require(trace["manual_fixture"] is True, "Fixture flag must be explicit")
    require(trace["execution_status"] == "not_run", "Do not imply live execution")
    messages = unique_index(trace["source_messages"])
    require(
        all(m["role"] == "user" and m["illustrative"] is True for m in messages.values()),
        "This fixture must not contain purported real user authorization",
    )
    span_count = 0

    def visit(value):
        nonlocal span_count
        if isinstance(value, dict):
            if {"message_id", "quote", "span"} <= value.keys():
                require(value["message_id"] in messages, "Unknown source message")
                source = messages[value["message_id"]]["text"]
                span = value["span"]
                require(span["unit"] == "unicode_codepoint", "Wrong span unit")
                start = span["start_inclusive"]
                end = span["end_exclusive"]
                require(0 <= start < end <= len(source), "Out-of-range source span")
                require(source[start:end] == value["quote"], "Source quote mismatch")
                span_count += 1
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(trace)
    return messages, span_count


def validate_intent_trace(trace):
    messages, span_count = validate_sources(trace)
    intent = trace["intent"]
    requirements = unique_index(intent["requirements"])
    require(intent["state"] == "draft", "Intent example is an unapproved draft")
    require(set(intent["source_ids"]) <= messages.keys(), "Dangling intent source")
    require(trace["planning"]["state"] == "planning", "Wrong planning state")
    require(trace["planning"]["approved_draft_revision"] is None, "No approval is present")
    require(trace["planning"]["execution_authorized"] is False, "Draft cannot authorize execution")
    work = trace["work_item"]
    require(work["state"] == "draft", "Work example must remain a draft")
    require(set(work["requirement_ids"]) <= requirements.keys(), "Dangling work requirement")
    require(work["intent_revision"] == intent["revision"], "Work revision mismatch")
    result = trace["result"]
    require(result["intent_revision"] == intent["revision"], "Result revision mismatch")
    require(set(result["scope"]["requirement_ids"]) == requirements.keys(), "Result scope mismatch")
    checks = unique_index(result["checks"], "requirement_id")
    require(checks.keys() == requirements.keys(), "Result check references mismatch")
    require(result["state"] == "not_executed", "Example must not imply executed work")
    require(all(c["status"] == "not_run" for c in checks.values()), "Example checks were not run")
    for requirement in requirements.values():
        require(requirement["kind"] in {"outcome", "constraint", "permission"}, "Unknown kind")
        if requirement.get("conditional_permission"):
            require(requirement["kind"] == "permission", "Conditional permission kind mismatch")
    return span_count


def validate_steering_trace(trace):
    messages, span_count = validate_sources(trace)
    requirements = unique_index(trace["requirements"])
    revisions = unique_index(trace["intent_revisions"], "revision")
    drafts = unique_index(trace["drafts"])
    approvals = unique_index(trace["approvals"])
    work_items = unique_index(trace["work_items"])
    events = unique_index(trace["events"])
    result_events = unique_index(
        [event for event in events.values() if "result_id" in event], "result_id"
    )
    require(
        [event["sequence"] for event in trace["events"]] == list(range(1, len(events) + 1)),
        "Hypothetical event sequence must be consecutive and ordered",
    )
    for requirement in requirements.values():
        require(requirement["version"] >= 1, "Invalid requirement version")
        require(requirement["kind"] in {"outcome", "constraint", "permission"}, "Unknown kind")
    for revision in revisions.values():
        require(set(revision["requirement_ids"]) <= requirements.keys(), "Dangling revision requirement")
        require(set(revision["source_message_ids"]) <= messages.keys(), "Dangling revision source")
        if "supersedes" in revision:
            require(revision["supersedes"] in revisions, "Missing earlier revision")
            require(revision["supersedes"] < revision["revision"], "Invalid revision order")
    for draft in drafts.values():
        require(draft["intent_revision"] in revisions, "Dangling draft revision")
        require(bool(draft["user_visible_plan"]), "Draft must identify displayed content")
    for approval in approvals.values():
        require(approval["draft_id"] in drafts, "Dangling approval target")
        draft = drafts[approval["draft_id"]]
        require(approval["draft_revision"] == draft["draft_revision"], "Approval draft mismatch")
        require(approval["approved_intent_revision"] == draft["intent_revision"], "Approval intent mismatch")
    for work in work_items.values():
        require(work["fixture_only"] is True, "Worktree labels are fictitious")
        require(work["initial_intent_revision"] in revisions, "Dangling work revision")
        initial = revisions[work["initial_intent_revision"]]
        require(set(work["bound_requirement_versions"]) <= set(initial["requirement_ids"]), "Work refers to a future requirement")
        for requirement_id, version in work["bound_requirement_versions"].items():
            require(requirements[requirement_id]["version"] == version, "Work requirement version mismatch")
    for event in events.values():
        require(isinstance(event["expected"], dict) and event["expected"], "Each event needs expectations")
        if "source_message_id" in event:
            require(event["source_message_id"] in messages, "Dangling event source")
        for field in ("source_event_ids", "acknowledged_event_ids", "amendment_event_ids"):
            for reference in event.get(field, []):
                require(reference in events, "Dangling earlier event reference")
                require(events[reference]["sequence"] < event["sequence"], "Event refers to a future event")
        for field in ("draft_id", "refers_to_draft"):
            if field in event:
                require(event[field] in drafts, "Dangling event draft")
        if "approval_id" in event:
            require(event["approval_id"] in approvals, "Dangling event approval")
        if "work_id" in event:
            require(event["work_id"] in work_items, "Dangling event work")
        for field in ("intent_revision", "source_intent_revision"):
            if field in event:
                require(event[field] in revisions, "Dangling event revision")
        for field in ("affected_work_ids", "unaffected_work_ids"):
            require(set(event.get(field, [])) <= work_items.keys(), "Dangling impacted work")
        require(set(event.get("added_requirement_ids", [])) <= requirements.keys(), "Dangling added requirement")
        require(set(event.get("new_scope_epochs", {})) <= work_items.keys(), "Dangling epoch work")
        for requirement_id, version in event.get("required_requirement_versions", {}).items():
            require(requirement_id in requirements, "Dangling required requirement")
            require(requirements[requirement_id]["version"] == version, "Required version mismatch")
    expected = trace["expected_final_snapshot"]
    require(expected["intent_revision"] in revisions, "Dangling expected revision")
    require(set(expected["scope_epochs"]) == work_items.keys(), "Expected scope set mismatch")
    require(set(expected["stale_result_ids"]) <= result_events.keys(), "Dangling expected stale result")
    require(set(expected["unaffected_work_ids"]) <= work_items.keys(), "Dangling expected unaffected work")
    require(expected["verified_completion"] is False, "Fixture cannot claim completed implementation")
    for result_id in expected["stale_result_ids"]:
        event = result_events[result_id]
        require(event["scope_epoch"] < expected["scope_epochs"][event["work_id"]], "Stale fixture epoch mismatch")
    return span_count, len(events)


def main():
    trace = json.loads((ROOT / "examples/intent_trace.json").read_text())
    intent_spans = validate_intent_trace(trace)
    corrupted = copy.deepcopy(trace)
    api_requirement = next(r for r in corrupted["intent"]["requirements"] if r["id"] == "R-api")
    api_requirement["text"] = "기존 함수 이름을 유지한다."
    require(corrupted != trace, "Semantic counterexample was not modified")
    validate_intent_trace(corrupted)
    steering = json.loads((ROOT / "examples/steering_trace.json").read_text())
    steering_spans, event_count = validate_steering_trace(steering)
    cases = [json.loads(line) for line in (ROOT / "eval/cases.jsonl").read_text().splitlines() if line]
    unique_index(cases)
    require(len(cases) == 32, "Expected 32 manual acceptance specifications")
    for case in cases:
        require(case["manual_fixture"] is True, "Manual status missing")
        require(case["evaluation_status"] == "not_run", "Manual cases were not executed")
        require(bool(case["kind"]) and bool(case["request"]), "Scenario description missing")
        require(isinstance(case["setup"], dict) and case["setup"], "Scenario setup missing")
        require(bool(case["expected_invariants"]), "Scenario needs expected invariants")
        require(all(isinstance(v, str) and v for v in case["expected_invariants"]), "Invalid invariant")
    print(json.dumps({
        "source_spans_checked": {"intent_trace": intent_spans, "steering_trace": steering_spans},
        "manual_cases": len(cases),
        "hypothetical_steering_events": event_count,
        "record_references_and_event_order": "structurally_valid",
        "normal_intent_example": "structurally_valid",
        "semantically_narrowed_example": "also_structurally_valid",
        "conclusion": "Source pointers and record validation alone do not prove intent fidelity.",
        "natural_language_interpretation": "not_evaluated",
        "manual_acceptance_execution": "not_run",
        "live_omp_git_or_model_evaluation": "not_run",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
