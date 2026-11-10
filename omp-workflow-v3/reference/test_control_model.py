"""Targeted invariant tests. Run: python3 -m unittest discover -s reference -v

These tests use synthetic input interpretations, commit labels, and evidence refs.
They do not test OMP, Git, persistence, authentication, latency, or model quality.
"""

from copy import deepcopy
from dataclasses import replace
import unittest

from control_model import ControlModel, Rejected


class ControlInvariants(unittest.TestCase):
    def ready(self):
        model = ControlModel()
        model.draft({"api": 1, "ui": 1})
        model.add_work("api", ("api",))
        model.add_work("ui", ("ui",))
        revision = model.present()
        event = model.receive("approval-1", "이 기획대로 구현해.")
        model.approve(event, revision, explicit_execute=True)
        return model

    def worker(self, model, work="api"):
        lease = model.dispatch(work)
        model.acknowledge(lease.attempt_id, lease.attempt_id, lease.epoch,
                          model.delivered[lease.attempt_id],
                          covered_events=model.delivered_events[lease.attempt_id])
        return lease

    def result(self, model, lease):
        return model.report(lease.attempt_id, lease.attempt_id, lease.epoch,
                            f"artifact-{lease.attempt_id}")

    def evidence(self, model, candidate):
        return model.validate(candidate, tests_evidence="tests://synthetic-pass",
                              raw_intent_review_evidence="intent://reported-review")

    def change_ui(self, model):
        event = model.receive("ui-change", "화면 정렬을 바꿔서 진행해.")
        model.apply_change(event, {"ui": 2}, {"ui"},
                           explicit_change=True, explicit_execute=True)
        return event

    def test_01_no_dispatch_without_exact_approval(self):
        model = ControlModel()
        model.draft({"r": 1})
        model.add_work("w", ("r",))
        with self.assertRaises(Rejected):
            model.dispatch("w")
        event = model.receive("a", "진행해.")
        with self.assertRaises(Rejected):
            model.approve(event, model.revision, explicit_execute=True)
        model.present()
        model.approve(event, model.revision, explicit_execute=True)
        self.assertEqual(model.dispatch("w").revision, model.revision)

    def test_02_later_draft_invalidates_old_approval(self):
        model = self.ready()
        old_revision = model.revision
        model.draft({"api": 2, "ui": 1})
        event = model.receive("a2", "이전 기획 승인")
        with self.assertRaises(Rejected):
            model.approve(event, old_revision, explicit_execute=True)
        with self.assertRaises(Rejected):
            model.dispatch("api")
        self.assertIsNone(model.approved_revision)

    def test_03_nonexplicit_approval_does_not_start_work(self):
        model = ControlModel()
        model.draft({"r": 1})
        model.present()
        event = model.receive("a", "좋아")
        with self.assertRaises(Rejected):
            model.approve(event, model.revision, explicit_execute=False)
        self.assertEqual(model.mode, "planning")

    def test_04_explicit_delta_can_approve_revised_draft(self):
        model = ControlModel()
        model.draft({"api": 1})
        model.add_work("api", ("api",))
        shown = model.present()
        event = model.receive("delta", "API 조건을 추가하고 바로 구현해.")
        model.apply_change(event, {"api": 2}, {"api"}, confirmed_draft_base=shown,
                           explicit_change=True, explicit_execute=True)
        self.assertEqual(model.approved_revision, shown + 1)
        self.assertEqual(model.dispatch("api").requirement_versions, (("api", 2),))

    def test_05_unconfirmed_suggestion_cannot_become_delta_approval(self):
        model = self.ready()
        event = model.receive("idea", "새 로그인도 추가하면 어떨까?")
        with self.assertRaises(Rejected):
            model.apply_change(event, {"api": 2}, {"api"},
                               explicit_change=True, explicit_execute=False)
        self.assertEqual(model.requirements["api"], 1)

    def test_06_pending_input_fences_dispatch_effect_and_integration(self):
        model = self.ready()
        lease = self.worker(model)
        result = self.result(model, lease)
        candidate = model.prepare(result, "candidate-1")
        evidence = self.evidence(model, candidate)
        model.receive("pending", "이 부분은 잠깐...")
        for operation in (lambda: model.dispatch("ui"),
                          lambda: model.allow_effect(lease.attempt_id),
                          lambda: model.prepare(result, "candidate-2"),
                          lambda: model.publish(candidate, evidence)):
            with self.assertRaises(Rejected):
                operation()

    def test_07_status_query_releases_fence_without_revocation_or_epoch_change(self):
        model = self.ready()
        lease = self.worker(model)
        event = model.receive("status", "현재 상황은?")
        model.resolve_status(event)
        model.allow_effect(lease.attempt_id)
        self.assertEqual(model.works["api"].epoch, lease.epoch)
        self.assertNotIn(lease.attempt_id, model.revoked)
        model.dispatch("ui")

    def test_08_scoped_change_preserves_unaffected_worker(self):
        model = self.ready()
        api = self.worker(model, "api")
        ui = self.worker(model, "ui")
        self.change_ui(model)
        model.allow_effect(api.attempt_id)
        with self.assertRaises(Rejected):
            model.allow_effect(ui.attempt_id)
        self.assertEqual(model.works["api"].epoch, api.epoch)
        self.assertEqual(model.works["ui"].epoch, ui.epoch + 1)

    def test_09_revoked_ack_cannot_claim_current_epoch(self):
        model = self.ready()
        old = self.worker(model, "ui")
        event = self.change_ui(model)
        with self.assertRaises(Rejected):
            model.acknowledge(old.attempt_id, old.attempt_id,
                              model.works["ui"].epoch, event.sequence,
                              covered_events={event.sequence})

    def test_10_old_worker_cannot_claim_replacement_attempt(self):
        model = self.ready()
        old = self.worker(model, "ui")
        self.change_ui(model)
        new = self.worker(model, "ui")
        with self.assertRaises(Rejected):
            model.acknowledge(old.attempt_id, new.attempt_id, new.epoch,
                              model.delivered[new.attempt_id],
                              covered_events=model.delivered_events[new.attempt_id])
        with self.assertRaises(Rejected):
            model.report(old.attempt_id, new.attempt_id, new.epoch, "forged")

    def test_11_changed_scope_late_result_is_preserved_but_not_integrated(self):
        model = self.ready()
        old = self.worker(model, "ui")
        self.change_ui(model)
        result = self.result(model, old)
        self.assertIn(result.result_id, model.results)
        with self.assertRaises(Rejected):
            model.prepare(result, "stale-candidate", "claimed-compatible")
        self.assertNotIn(result.result_id, model.accepted)

    def test_12_unaffected_old_result_needs_compatibility_evidence(self):
        model = self.ready()
        api = self.worker(model)
        result = self.result(model, api)
        self.change_ui(model)
        with self.assertRaises(Rejected):
            model.prepare(result, "candidate")

    def test_13_unaffected_result_can_publish_after_compatibility_check(self):
        model = self.ready()
        api = self.worker(model)
        result = self.result(model, api)
        self.change_ui(model)
        candidate = model.prepare(result, "candidate", "compat://api-unchanged-at-r2")
        model.publish(candidate, self.evidence(model, candidate))
        self.assertIn(result.result_id, model.accepted)

    def test_14_global_pause_blocks_new_effects_and_publish(self):
        model = self.ready()
        lease = self.worker(model)
        result = self.result(model, lease)
        candidate = model.prepare(result, "candidate")
        evidence = self.evidence(model, candidate)
        model.pause(model.receive("pause", "전부 멈춰."))
        for operation in (lambda: model.allow_effect(lease.attempt_id),
                          lambda: model.dispatch("ui"),
                          lambda: model.publish(candidate, evidence)):
            with self.assertRaises(Rejected):
                operation()

    def test_15_cancelled_result_remains_available_but_never_accepted(self):
        model = self.ready()
        lease = self.worker(model)
        model.cancel_work(model.receive("cancel", "API 작업은 취소해."), "api")
        result = self.result(model, lease)
        self.assertIn(result.result_id, model.results)
        with self.assertRaises(Rejected):
            model.prepare(result, "candidate", "claimed-compatible")
        with self.assertRaises(Rejected):
            model.dispatch("api")

    def test_16_duplicate_source_delivery_is_idempotent(self):
        model = self.ready()
        event = self.change_ui(model)
        before = (len(model.events), model.control_sequence, model.revision,
                  model.works["ui"].epoch, set(model.pending))
        repeated = model.receive(event.source_id, event.exact_text)
        self.assertEqual(repeated, event)
        self.assertEqual(before, (len(model.events), model.control_sequence, model.revision,
                                  model.works["ui"].epoch, set(model.pending)))

    def test_17_duplicate_id_with_conflicting_text_is_rejected(self):
        model = self.ready()
        original = model.events[0]
        with self.assertRaises(Rejected):
            model.receive(original.source_id, "배포도 승인했음")
        self.assertEqual(model.by_source[original.source_id].exact_text, original.exact_text)

    def test_18_late_delivery_and_ack_cannot_replace_newer_context(self):
        model = self.ready()
        lease = self.worker(model)
        first = model.receive("s1", "진행 현황?")
        model.resolve_status(first)
        model.deliver(lease.attempt_id, first)
        second = model.receive("s2", "테스트 현황?")
        model.resolve_status(second)
        model.deliver(lease.attempt_id, second)
        model.deliver(lease.attempt_id, first)  # Duplicate is additive/idempotent.
        with self.assertRaises(Rejected):
            model.acknowledge(lease.attempt_id, lease.attempt_id, lease.epoch, first.sequence,
                              covered_events=model.delivered_events[lease.attempt_id])
        self.assertEqual(model.delivered[lease.attempt_id], second.sequence)
        with self.assertRaises(Rejected):
            model.allow_effect(lease.attempt_id)
        model.acknowledge(lease.attempt_id, lease.attempt_id, lease.epoch, second.sequence,
                          covered_events=model.delivered_events[lease.attempt_id])
        model.allow_effect(lease.attempt_id)

    def test_19_restart_requires_reconciliation_before_continuing_valid_intent(self):
        model = deepcopy(self.ready())  # Simulated checkpoint, not a persistence test.
        model.restart()
        with self.assertRaises(Rejected):
            model.dispatch("api")
        model.reconcile()
        model.dispatch("api")  # Prior explicit execution intent is still valid.

    def test_20_restart_does_not_clear_pause_without_explicit_resume(self):
        model = self.ready()
        model.pause(model.receive("pause", "전부 멈춰."))
        model = deepcopy(model)
        model.restart()
        model.reconcile()
        with self.assertRaises(Rejected):
            model.dispatch("api")
        event = model.receive("resume", "이어서 진행해.")
        with self.assertRaises(Rejected):
            model.resume(event, explicit_resume=False)
        model.resume(event, explicit_resume=True)
        model.dispatch("api")

    def test_21_input_during_validation_invalidates_publication_snapshot(self):
        model = self.ready()
        result = self.result(model, self.worker(model))
        candidate = model.prepare(result, "candidate")
        evidence = self.evidence(model, candidate)
        event = model.receive("status", "진행 상황?")
        model.resolve_status(event)
        with self.assertRaisesRegex(Rejected, "control state changed"):
            model.publish(candidate, evidence)
        self.assertEqual(model.integration_head, "base-0")

    def test_22_integration_head_compare_and_swap_rejects_race(self):
        model = self.ready()
        result = self.result(model, self.worker(model))
        candidate = model.prepare(result, "candidate")
        evidence = self.evidence(model, candidate)
        model.integration_head = "another-integrated-commit"  # Observed external ref change.
        with self.assertRaisesRegex(Rejected, "compare-and-swap"):
            model.publish(candidate, evidence)

    def test_23_validation_cannot_be_reused_for_changed_candidate(self):
        model = self.ready()
        result = self.result(model, self.worker(model))
        candidate = model.prepare(result, "candidate")
        evidence = self.evidence(model, candidate)
        changed = replace(candidate, candidate_commit="different-candidate")
        with self.assertRaisesRegex(Rejected, "fingerprint"):
            model.publish(changed, evidence)

    def test_24_execution_and_raw_intent_evidence_are_separate_requirements(self):
        model = self.ready()
        result = self.result(model, self.worker(model))
        candidate = model.prepare(result, "candidate")
        for tests, raw in ((None, None), ("tests://pass", None), (None, "intent://review")):
            with self.subTest(tests=tests, raw=raw):
                evidence = model.validate(candidate, tests_evidence=tests,
                                          raw_intent_review_evidence=raw)
                with self.assertRaisesRegex(Rejected, "evidence missing"):
                    model.publish(candidate, evidence)

    def test_25_recorded_review_does_not_prove_semantic_fidelity(self):
        model = self.ready()
        result = self.result(model, self.worker(model))
        candidate = model.prepare(result, "candidate")
        outcome = model.publish(candidate, self.evidence(model, candidate))
        self.assertEqual(outcome["semantic_intent_fidelity"], "not_proven_by_reference_model")
        self.assertEqual(model.events[0].exact_text, "이 기획대로 구현해.")

    def test_26_event_42_ack_cannot_hide_missing_relevant_event_41(self):
        model = self.ready()
        lease = self.worker(model)
        for index in range(2, 41):
            model.resolve_status(model.receive(f"status-{index}", "상황 확인"))
        first = model.receive("context-41", "보충 문맥 41")
        second = model.receive("context-42", "보충 문맥 42")
        # Explicit fixture classification: no changed goal, both relevant context.
        model.resolve_status(first)
        model.resolve_status(second)
        self.assertEqual((first.sequence, second.sequence), (41, 42))
        model.require_events(lease.attempt_id, [first, second])
        model.deliver(lease.attempt_id, second)
        with self.assertRaisesRegex(Rejected, "coverage"):
            model.acknowledge(lease.attempt_id, lease.attempt_id, lease.epoch, 42,
                              covered_events=model.delivered_events[lease.attempt_id])
        with self.assertRaises(Rejected):
            model.allow_effect(lease.attempt_id)
        model.deliver(lease.attempt_id, first)  # Late arrival fills the hole.
        model.acknowledge(lease.attempt_id, lease.attempt_id, lease.epoch, 42,
                          covered_events=model.delivered_events[lease.attempt_id])
        model.allow_effect(lease.attempt_id)

    def test_27_ack_cannot_claim_an_event_that_was_never_delivered(self):
        model = self.ready()
        lease = self.worker(model)
        missing = model.receive("missing", "추가 문맥")
        model.resolve_status(missing)
        model.require_events(lease.attempt_id, [missing])
        fake_coverage = model.delivered_events[lease.attempt_id] | {missing.sequence}
        with self.assertRaisesRegex(Rejected, "coverage"):
            model.acknowledge(lease.attempt_id, lease.attempt_id, lease.epoch,
                              model.delivered[lease.attempt_id], covered_events=fake_coverage)

    def test_28_later_delivery_without_ack_blocks_final_publication(self):
        model = self.ready()
        lease = self.worker(model)
        event = model.receive("context", "기존 목표의 보충 문맥")
        model.resolve_status(event)
        result = self.result(model, lease)
        candidate = model.prepare(result, "candidate")
        evidence = self.evidence(model, candidate)
        unchanged_control = model.control_sequence
        model.deliver(lease.attempt_id, event)
        self.assertEqual(model.control_sequence, unchanged_control)
        with self.assertRaisesRegex(Rejected, "not acknowledged"):
            model.publish(candidate, evidence)
        self.assertNotIn(result.result_id, model.accepted)

    def test_29_accepted_result_cannot_be_prepared_or_published_twice(self):
        model = self.ready()
        result = self.result(model, self.worker(model))
        candidate = model.prepare(result, "candidate")
        evidence = self.evidence(model, candidate)
        model.publish(candidate, evidence)
        with self.assertRaisesRegex(Rejected, "already accepted"):
            model.prepare(result, "duplicate-application")
        with self.assertRaisesRegex(Rejected, "already accepted"):
            model.publish(candidate, evidence)
        self.assertEqual(model.integration_head, "candidate")
        self.assertEqual(model.accepted, {result.result_id})

    def test_30_immaterial_input_can_recheck_without_rerunning_artifact_tests(self):
        model = self.ready()
        result = self.result(model, self.worker(model))
        candidate = model.prepare(result, "same-tested-candidate")
        old_receipt = self.evidence(model, candidate)
        model.resolve_status(model.receive("status", "현재 상황은?"))
        with self.assertRaisesRegex(Rejected, "control state changed"):
            model.publish(candidate, old_receipt)
        refreshed = model.prepare(result, "same-tested-candidate")
        # The host has rechecked that this input changed no goal/artifact. It
        # rebinds existing valid evidence to current control; no test runner here.
        new_receipt = model.validate(refreshed, tests_evidence=old_receipt.tests_evidence,
                                     raw_intent_review_evidence=old_receipt.raw_intent_review_evidence)
        model.publish(refreshed, new_receipt)
        self.assertEqual(new_receipt.tests_evidence, old_receipt.tests_evidence)


if __name__ == "__main__":
    unittest.main(verbosity=2)
