"""In-memory reference model of v3 control invariants; not an OMP integration.

All input classifications and impact sets are supplied explicitly by tests.
This module does not parse natural language, authenticate workers, persist data,
run providers/tools/Git, isolate processes, or establish semantic intent fidelity.
The fingerprint binds a test receipt to a candidate; it is not authentication.
The schema is illustrative, not a required native API or production design.

The host declares per-attempt relevant event sets before delivery. Delivery and
ACK sets are checked independently; a highest sequence cannot cover a hole.
Relevance discovery and evidence truth remain outside this reference model.

Any input invalidates a prepared candidate here, even an immaterial status query.
A real implementation can recheck current control/coverage and reuse unchanged
artifact test evidence; a fresh receipt does not imply rerunning those tests.

Initial approval and user-confirmed scope changes use one revision counter here.
Restart preserves prior execution intent; a prior pause still needs explicit
resume. Reconciliation is mandatory before any new effect or publication.
"""

from dataclasses import asdict, dataclass
from hashlib import sha256
import json


class Rejected(RuntimeError):
    pass


@dataclass(frozen=True)
class UserEvent:
    sequence: int
    source_id: str
    exact_text: str


@dataclass
class Work:
    requirement_ids: tuple[str, ...]
    epoch: int = 0
    current_attempt: str | None = None
    cancelled: bool = False


@dataclass(frozen=True)
class Lease:
    attempt_id: str
    work_id: str
    epoch: int
    revision: int
    requirement_versions: tuple[tuple[str, int], ...]
    base_commit: str


@dataclass(frozen=True)
class Result:
    result_id: str
    lease: Lease
    artifact_commit: str


@dataclass(frozen=True)
class Candidate:
    result_id: str
    revision: int
    control_sequence: int
    expected_head: str
    candidate_commit: str
    source_artifact_commit: str
    epoch: int
    requirement_versions: tuple[tuple[str, int], ...]
    raw_source_ids: tuple[str, ...]
    compatibility_evidence: str | None


@dataclass(frozen=True)
class Validation:
    fingerprint: str
    tests_evidence: str | None
    raw_intent_review_evidence: str | None


def fingerprint(candidate: Candidate) -> str:
    payload = json.dumps(asdict(candidate), sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode("utf-8")).hexdigest()


class ControlModel:
    def __init__(self):
        self.events: list[UserEvent] = []
        self.by_source: dict[str, UserEvent] = {}
        self.pending: set[int] = set()
        self.control_sequence = 0
        self.revision = 0
        self.presented_revision: int | None = None
        self.approved_revision: int | None = None
        self.requirements: dict[str, int] = {}
        self.works: dict[str, Work] = {}
        self.leases: dict[str, Lease] = {}
        self.revoked: set[str] = set()
        self.delivered: dict[str, int] = {}
        self.acknowledged: dict[str, int] = {}
        self.required_events: dict[str, set[int]] = {}
        self.delivered_events: dict[str, set[int]] = {}
        self.acknowledged_events: dict[str, set[int]] = {}
        self.results: dict[str, Result] = {}
        self.accepted: set[str] = set()
        self.integration_head = "base-0"
        self.mode = "planning"
        self.recovery_pending = False

    def receive(self, source_id: str, exact_text: str) -> UserEvent:
        if source_id in self.by_source:
            old = self.by_source[source_id]
            if old.exact_text != exact_text:
                raise Rejected("same source ID with different content")
            return old  # Re-delivery is not a fresh command or revision.
        event = UserEvent(len(self.events) + 1, source_id, exact_text)
        self.events.append(event)
        self.by_source[source_id] = event
        self.pending.add(event.sequence)
        self.control_sequence += 1
        return event

    def _pending_event(self, event: UserEvent):
        if self.by_source.get(event.source_id) != event or event.sequence not in self.pending:
            raise Rejected("event is not pending")

    def _settle(self, event: UserEvent):
        self._pending_event(event)
        self.pending.remove(event.sequence)
        self.control_sequence += 1

    def resolve_status(self, event: UserEvent):
        self._settle(event)  # No epoch change or worker cancellation.

    def draft(self, requirements: dict[str, int]) -> int:
        self.revision += 1
        self.requirements = dict(requirements)
        self.approved_revision = None
        self.presented_revision = None
        self.mode = "planning"
        for work in self.works.values():
            self._revoke(work)
            work.epoch += 1
        self.control_sequence += 1
        return self.revision

    def present(self) -> int:
        self.presented_revision = self.revision
        return self.revision

    def approve(self, event: UserEvent, revision: int, *, explicit_execute: bool):
        self._pending_event(event)
        if not explicit_execute or revision != self.revision or revision != self.presented_revision:
            raise Rejected("approval must identify the presented current draft")
        self.approved_revision = revision
        self.mode = "executing"
        self._settle(event)

    def add_work(self, work_id: str, requirement_ids: tuple[str, ...]):
        if work_id in self.works or not set(requirement_ids) <= self.requirements.keys():
            raise Rejected("invalid work definition")
        self.works[work_id] = Work(requirement_ids)

    def _revoke(self, work: Work):
        if work.current_attempt is not None:
            self.revoked.add(work.current_attempt)

    def apply_change(self, event: UserEvent, updates: dict[str, int], affected: set[str],
                     *, explicit_change: bool, explicit_execute: bool,
                     confirmed_draft_base: int | None = None):
        """The caller supplies the interpreted instruction, not a model confidence.

        confirmed_draft_base supports 'take this draft, add X, then implement'.
        Otherwise this is an explicit instruction amending approved work.
        Impact closure beyond known requirement bindings is the caller's job.
        """
        self._pending_event(event)
        if not explicit_change or not explicit_execute:
            raise Rejected("an unconfirmed suggestion cannot authorize execution")
        if confirmed_draft_base is not None:
            if confirmed_draft_base != self.revision or confirmed_draft_base != self.presented_revision:
                raise Rejected("delta does not identify the presented current draft")
        elif self.approved_revision != self.revision:
            raise Rejected("there is no approved work to amend")
        if not affected <= self.works.keys():
            raise Rejected("unknown affected work")
        if any(value <= self.requirements.get(key, 0) for key, value in updates.items()):
            raise Rejected("requirement versions must advance")
        affected = affected | {
            key for key, work in self.works.items()
            if set(work.requirement_ids) & updates.keys()
        }
        self.requirements.update(updates)
        self.revision += 1
        self.approved_revision = self.revision
        self.presented_revision = None
        if self.mode == "planning":
            self.mode = "executing"
        for key in affected:
            self._revoke(self.works[key])
            self.works[key].epoch += 1
        self._settle(event)

    def _ready(self):
        if self.recovery_pending:
            raise Rejected("reconciliation required")
        if self.pending:
            raise Rejected("unclassified user input fences new effects")
        if self.mode != "executing" or self.approved_revision != self.revision:
            raise Rejected("current execution intent is absent or paused")

    def _versions(self, work: Work) -> tuple[tuple[str, int], ...]:
        return tuple(sorted((key, self.requirements[key]) for key in work.requirement_ids))

    def dispatch(self, work_id: str) -> Lease:
        self._ready()
        work = self.works[work_id]
        if work.cancelled:
            raise Rejected("work cancelled")
        self._revoke(work)
        attempt_id = f"attempt-{len(self.leases) + 1}"
        lease = Lease(attempt_id, work_id, work.epoch, self.revision,
                      self._versions(work), self.integration_head)
        self.leases[attempt_id] = lease
        work.current_attempt = attempt_id
        self.delivered[attempt_id] = len(self.events)
        # A simulated initial ContextView covers all pre-dispatch event IDs.
        # No transcript is transmitted by this model; these are coverage labels.
        initial = {event.sequence for event in self.events}
        self.required_events[attempt_id] = set(initial)
        self.delivered_events[attempt_id] = set(initial)
        return lease

    def _active(self, attempt_id: str) -> Lease:
        lease = self.leases[attempt_id]
        work = self.works[lease.work_id]
        if (attempt_id in self.revoked or work.cancelled or work.current_attempt != attempt_id
                or work.epoch != lease.epoch or self._versions(work) != lease.requirement_versions):
            raise Rejected("worker attempt is revoked or stale")
        return lease

    def require_events(self, attempt_id: str, events: list[UserEvent]):
        """Declare relevant resolved events before any delivery; never drops one."""
        self._active(attempt_id)
        if any(event.sequence in self.pending or self.by_source.get(event.source_id) != event
               for event in events):
            raise Rejected("event must be reconciled before relevance/delivery")
        self.required_events[attempt_id].update(event.sequence for event in events)

    def deliver(self, attempt_id: str, event: UserEvent):
        self.require_events(attempt_id, [event])
        self.delivered_events[attempt_id].add(event.sequence)
        # Out-of-order arrival can fill a hole; it cannot replace newer context.
        self.delivered[attempt_id] = max(self.delivered[attempt_id], event.sequence)

    def acknowledge(self, caller_attempt: str, claimed_attempt: str, epoch: int, sequence: int,
                    *, covered_events: set[int]):
        # A real adapter must bind caller_attempt to its transport/session identity.
        if caller_attempt != claimed_attempt:
            raise Rejected("caller cannot claim another worker attempt")
        lease = self._active(caller_attempt)
        if epoch != lease.epoch or sequence != self.delivered[caller_attempt]:
            raise Rejected("acknowledgement does not match the issued lease/context")
        covered = set(covered_events)
        if (covered != self.delivered_events[caller_attempt]
                or not self.required_events[caller_attempt] <= covered):
            raise Rejected("acknowledgement coverage has a hole or undelivered event")
        self.acknowledged[caller_attempt] = sequence
        self.acknowledged_events[caller_attempt] = covered

    def allow_effect(self, attempt_id: str):
        self._ready()
        self._active(attempt_id)
        if (self.acknowledged.get(attempt_id) != self.delivered[attempt_id]
                or self.acknowledged_events.get(attempt_id) != self.delivered_events[attempt_id]
                or not self.required_events[attempt_id] <= self.acknowledged_events.get(attempt_id, set())):
            raise Rejected("current delivery is not acknowledged")

    def report(self, caller_attempt: str, claimed_attempt: str, epoch: int, commit: str) -> Result:
        if caller_attempt != claimed_attempt:
            raise Rejected("caller cannot report for another attempt")
        lease = self.leases[caller_attempt]
        if epoch != lease.epoch:
            raise Rejected("worker cannot rewrite its issued lease")
        # Preserve even revoked/cancelled results; recording is not acceptance.
        result = Result(f"result-{len(self.results) + 1}", lease, commit)
        self.results[result.result_id] = result
        return result

    def prepare(self, result: Result, commit: str, compatibility_evidence: str | None = None) -> Candidate:
        if result.result_id in self.accepted:
            raise Rejected("result already accepted; do not apply it twice")
        self.allow_effect(result.lease.attempt_id)
        if self.results.get(result.result_id) != result:
            raise Rejected("unknown result")
        if result.lease.revision != self.revision and not compatibility_evidence:
            raise Rejected("older unaffected result requires compatibility evidence")
        return Candidate(result.result_id, self.revision, self.control_sequence,
                         self.integration_head, commit, result.artifact_commit,
                         result.lease.epoch, result.lease.requirement_versions,
                         tuple(event.source_id for event in self.events), compatibility_evidence)

    def validate(self, candidate: Candidate, *, tests_evidence: str | None,
                 raw_intent_review_evidence: str | None) -> Validation:
        # Records claimed evidence references. No evidence truth or meaning is checked.
        return Validation(fingerprint(candidate), tests_evidence, raw_intent_review_evidence)

    def publish(self, candidate: Candidate, validation: Validation) -> dict[str, str]:
        if candidate.result_id in self.accepted:
            raise Rejected("result already accepted; do not apply it twice")
        self._ready()
        if candidate.expected_head != self.integration_head:
            raise Rejected("integration-head compare-and-swap failed")
        if candidate.control_sequence != self.control_sequence or candidate.revision != self.revision:
            raise Rejected("control state changed after candidate preparation")
        result = self.results[candidate.result_id]
        self.allow_effect(result.lease.attempt_id)
        if (candidate.epoch != result.lease.epoch
                or candidate.requirement_versions != result.lease.requirement_versions
                or candidate.source_artifact_commit != result.artifact_commit
                or candidate.raw_source_ids != tuple(event.source_id for event in self.events)):
            raise Rejected("candidate provenance does not match current recorded work")
        if result.lease.revision != self.revision and not candidate.compatibility_evidence:
            raise Rejected("compatibility evidence missing")
        if validation.fingerprint != fingerprint(candidate):
            raise Rejected("validation fingerprint does not match candidate")
        if not validation.tests_evidence or not validation.raw_intent_review_evidence:
            raise Rejected("required execution or raw-intent evidence missing")
        self.integration_head = candidate.candidate_commit
        self.accepted.add(result.result_id)
        return {"accepted_commit": self.integration_head,
                "semantic_intent_fidelity": "not_proven_by_reference_model"}

    def pause(self, event: UserEvent):
        self._pending_event(event)
        self.mode = "paused"
        self._settle(event)

    def resume(self, event: UserEvent, *, explicit_resume: bool):
        self._pending_event(event)
        if not explicit_resume or self.approved_revision != self.revision:
            raise Rejected("explicit valid resume intent required")
        self.mode = "executing"
        self._settle(event)

    def cancel_work(self, event: UserEvent, work_id: str):
        self._pending_event(event)
        work = self.works[work_id]
        work.cancelled = True
        self._revoke(work)
        work.epoch += 1
        self._settle(event)

    def restart(self):
        # Tests retain this object as a simulated checkpoint, not durable storage.
        self.recovery_pending = True
        self.control_sequence += 1

    def reconcile(self):
        # Real recovery must inspect processes, Git refs, and durable records.
        self.recovery_pending = False  # Does not change pause/cancel/approval state.
