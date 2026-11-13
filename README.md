# OMP Intent Workflow

A native-first OMP plugin: conversational planning, exact-plan approval, durable intent, scoped steering, real Git linked-worktree workers, and verified integration. Built for OMP **18.18.6** and Bun **1.4.4+**. The supplied `omp-workflow-v3/` remains original design/reference material, not execution evidence.

OMP must resolve a real `bun` executable on its `PATH`; the compiled `omp` executable is not a worker-script interpreter. The adapter waits for OS spawn confirmation, validates owned process-group PIDs before signalling, and preserves original startup errors when launch fails.

Planning drafts may contain open questions and unassigned outcomes. Approval and live execution changes still require every mandatory outcome and acceptance condition to have assigned work; drafting never authorizes execution.

## Install and use

```sh
bun install
omp plugin link . --scope user
omp plugin doctor
```

Start a **new OMP session** in the target Git repository or non-Git workspace directory. Describe your development goal normally. The plugin starts in planning, preserves original text and revisions, and displays requirements, assumptions, questions, work ownership, verification commands, and the exact approval digest. Revise freely. Once important questions are resolved, say `approve`, use `/workflow approve`, or approve the displayed digest with `/workflow approve <digest>`.

Approval authorizes the **displayed plan and its declared local verification commands**, not deployment, credential changes, arbitrary external effects, or destructive Git. A clear amendment plus execution instruction can approve the amended plan without a redundant confirmation. Native `/plan`, `/goal`, `/vibe`, or `/loop` conflicts are reported rather than silently changed.

Checks are self-contained executable argv, run by the host after artifact creation in a clean checkout, with stdin closed and no shell expansion. Task checks run again during final integration. Preservation checks use immutable hashes/bytes captured during planning, not baselines recaptured after implementation.

During execution, use natural-language questions/changes or:

- `/workflow status`, `/workflow plan [goal]`
- `/workflow tell <task-id> <instruction>`
- `/workflow pause [task-ids]`, `/workflow resume [task-ids]`
- `/workflow cancel [task-ids]`, `/workflow recover`
- `/workflow new [goal]`

Status uses one updating native widget for planning phase, short user-facing activity and scoped file target. It does not append a transcript message for each read/search, expose private reasoning, or make extra model-summary calls; optional short labels use existing tool-call metadata. Final plans, errors and outcomes remain messages. Receipt, delivered instructions, worker ACK, and verified results are distinct. A stop request fences new effects/adoption before waiting for observed worker termination. Unrelated work survives a scoped change. Unclassified input temporarily fences effects whose applicability is not known.

Declared write ownership and exclusive resources determine which ready tasks can overlap; the native `task.maxConcurrency` supplies the ceiling. There is no new token-thrift batch cap. Status/plan queries record receipts without reopening completed work.

## Native integration, not another service

The package manifest registers one OMP extension and native plugin settings. Models, existing authentication, SDK sessions, context/skill discovery, messages and terminal UI come from OMP. The plugin controller runs inside OMP; there is no separate server or persistent manager process. Worker processes exist only for assigned OMP SDK sessions. A native Task folder/isolation mode is **not** treated as evidence of a Git linked worktree.

A small public `CustomEditor` subclass preserves submitted expanded text before native trimming/emoticon normalization, retaining native editor behavior. An existing custom-editor owner produces an explicit conflict instead of being overwritten. Workflow workers are not native focused children: address them through the main workflow input or `tell`. Direct messages to unrelated native focused agents do not become workflow steering.

The native setting `enabled` controls plugin ownership. Use OMP's plugin settings UI/CLI; after enabling, reload/start a new TUI session so raw capture is installed first. Main-session ownership is claimed only when a workflow goal/control request is admitted, not merely because a run exists for the repository.

## State, worktrees and recovery

Canonical state is in OMP's native `getAgentDir()/workflows/<repo-key>/runs/<run-id>/intent.sqlite` (normally `~/.omp/agent/workflows/…`), respecting the active native profile/directory. The hash-linked append-only journal preserves original user inputs, requirements, exact approval, per-task epochs/attempts, delivery/ACK sets, results, exact-commit checks and adoption receipts. Image inputs are immutable hash-addressed blobs. Native session logs remain native; model-facing context is a projection, not a second authority.

Workers get distinct branches and actual `git worktree add` directories. The controller preserves the original staged/unstaged/untracked input in a private-index baseline without stashing/resetting/cleaning the user's checkout. Ignored files are not automatically included. Sensitive inputs, submodules, sparse/unmerged checkouts, special files and unsafe links are explicitly rejected rather than silently mishandled.

Only the controller updates the unchecked-out run-owned accepted ref. Candidate creation/checks happen outside the final short adoption boundary; current input/requirements/epochs/commit and expected old Git SHA are rechecked before publication. Git and SQLite are **not** one transaction: recovery reconciles prepared adoption records with the actual ref. Unknown/orphan processes are not labelled stopped, and restart does not clear pause/cancel.

The final report gives the tested artifact identity (Git commit or workspace manifest) and **actual executable result worktree**. The original checkout is not forcibly overwritten. A ref update alone is never represented as updating its files. Preserve result worktrees until you explicitly integrate/dispose of them.

### Non-Git roots and independent repositories

The source root does **not** need `.git` and is never initialized as one repository. Safe nested source repositories use their own actual linked worktrees, original histories and separate result commits. Files outside those owners use a private snapshot repository in the run state, not in the user's directory. Workers and checks see an assembled tree with the original relative paths; original checkouts, indexes and untracked files are not overwritten.

Nested source repositories, ordinary root guides/configuration and selected loose source scopes are captured with ignore/sensitive-input protections. Owner State/Vault/Runtime stores, Obsidian vaults, caches and dependency trees are not implicit source. Temporary trees are excluded unless an explicit source path selects a bounded subtree. A WorkSpec may include `readPaths` for necessary unversioned reference files/directories outside its `writePaths`; these are displayed before approval and grant no write permission.

`workspace:<sha256>` identifies an immutable manifest of exact component commits, **not** a Git commit usable with `git show`. One durable SQLite acceptance pointer coordinates that manifest; it does not pretend multiple repository refs update atomically. Completion reports the assembled result path and repository-specific commits. Historical reads choose the owning repository's exact baseline commit.

Checks run from the assembled root. `git diff --check` covers the committed delta in every component; evidence retains both the approved command and the actual component argv. Other repository-specific Git checks use `git -C <relative-component> ...`. Unsupported ambiguous root Git commands refuse rather than silently inspect only the private loose-file repository.

Workspace preparation must succeed before a new approval is recorded. A retained approval from an older non-Git initialization failure can be reopened and continued with `/workflow recover`; do not reset its journal or replay implementation to repair setup.

### Recover an unfinished plan

Re-enabling restores the same run intentionally; it does not erase pending intent or clear pause/cancel. Input receipts and bounded planning/tool activity are displayed while the SDK planner works.

- If no plan exists and the run is paused/cancelled, use **`/workflow resume` without a run ID**. It resumes planning from preserved goal inputs, not implementation.
- If planning failed or was interrupted without a global stop, use `/workflow recover`. It replaces the old planner and replans pending goals. It does not clear pause/cancel.
- `/workflow plan` only displays the current plan; `/workflow plan <goal>` submits a goal for planning.
- To abandon the old goal, use `/workflow cancel`, then `/workflow new [goal]`. The previous run and its unfinished raw inputs remain archived.

Failed control receipts are marked rejected rather than left blocking the queue. Recovery does not replay retained approvals, resumes, or new-goal commands as authority. Pause/cancel closes planners and rejects late responses; a newly displayed plan still requires exact-plan approval before implementation.

User requirements must cite nonempty, unique IDs of eligible original goal inputs. Repository/host policy and model-derived methods without a supporting user event belong in the displayed assumptions/proposals and work instructions, not invented user requirements. If the model returns an invalid plan, the controller supplies validation diagnostics for one corrective response in the same session without restarting research. It never fills source IDs itself or replays approval. A second invalid response stops planning with diagnostics and leaves the original inputs pending; provider failures are not automatically retried.

Failed host checks remain recorded and can trigger an in-scope implementation repair. Failed independent subtask/final reviews can reopen only approved responsible work and its dependants; unrelated accepted work and scoped pauses/cancellations remain intact. Repair artifacts retain the complete task delta and failed commits remain recoverable. Missing authority/important ambiguity is not treated as permission. Unchanged code plus repeated failed checks, or an unchanged artifact plus the same corrective scope, stops automatic repetition.

## Model, skill and effect policy

Conservative Sol routing is the default, with reasoning selected per responsibility. Each displayed work assignment records its resolved model selector; the main native model picker does not silently retarget approved workers. Change task models through planning/steering input. Explicit model choices are preserved; a catalog entry is not performance evidence. Terra is available for explicit evaluated sessions; cheaper/local classifiers are not approval/adoption authorities. Optional local judgment models are not required for installation.

Workers receive applicable original input, global/scoped constraints, the exact assignment and necessary evidence. Independent final review compares original intent and actual output; its cache binds raw input as well as requirements and commit. Native SDK discovery retains global/user/project skill metadata, preloads explicitly selected skills, and supplies guarded `skill://name[/resource]` reads for necessary bodies. Original project instructions/settings remain rooted at the original repository, not a relocated worktree's ancestry. The immutable context is reinserted across compaction.

Restricted worker file tools require live parent admission, task ownership, safe real paths and matching epoch/attempt/ACK. No ambient MCP/eval/nested Task is admitted. Worker `bash` is a small read-only Git-inspection argv interface, **not a general shell**. The controller runs explicitly approved checks. This is an execution policy, **not an OS sandbox**: do not run hostile projects or grant unreviewed external-effect commands. Already-running external effects cannot be retroactively cancelled.

Worker `read` always reads the current working tree (or a discovered skill resource). Historical bytes use the separate `read_history` tool with a required `HEAD` or full commit ID. Both report the whole-file SHA256 even when displaying only a line range.

## Verify and inspect evidence

```sh
bun test eval/recovery.test.ts
bun test eval/workspace.test.ts eval/progress.test.ts
bun test eval/workspace-controller.test.ts
bun test eval/client.test.ts
./scripts/verify-workflow
bun run check
```

Recovery and workspace-controller tests replace the session-client boundary and must run in separate Bun invocations. Client tests launch real worker processes with the SDK/provider boundary replaced; workspace tests use real Git repositories, worktrees and checks. The native non-Git/multi-owner proof at `.workflow/workspace-native-proof-9_nseu16/proof.json` exercised the actual installed CLI, guarded worker writes, checks and one updating progress widget using isolated home/state and deterministic SDK responses, with no provider calls. This establishes orchestration/display, not model planning quality. The existing fourteen-scenario provider acceptance report below predates these repairs.

The acceptance command uses **real existing-provider OMP calls and real Git worktrees**, including Korean planning revisions, approval, parallel implementation, steering, stop/resume, stale-result rejection, actual compaction/model replacement/session reopening, independent negative intent review, and native plugin lifecycle. It has provider usage and temporarily disables/re-enables this user-scope plugin as part of the approved recovery check. Run it from this project, outside an actively owned workflow session.

Evidence is written to `.workflow/verification/run-*/report.json`, with per-scenario outcomes, canonical state and execution timeline. Exit 0 requires all fourteen scenario entries to pass; failure or `not_run` is not success. The command compares the same model-produced functional contract in two explicitly approved benchmark-only scheduling variants, without repeating planning; it does not silently waive the actual goal's parallelism requirement. `scheduling/report.json` records elapsed times, peak native sessions and final verdicts. One remote-provider sample is not a universal speedup claim. Structural/reference checks cannot replace actual OMP evidence. `bun eval/control.ts` additionally exercises production approval/ACK/CAS/crash/cancellation and scoped repair boundaries with actual Git refs.

The context-maintenance case uses a separate clone with a project-local short-retention setting to exercise real native compaction on a small test history. It asserts a persisted native compaction record, actual model requests on both models, semantic obligations after switching, and exact-session reopening. This fixture does not change global or production token policy; all probe sessions close on failure.

## Disable or restore

Pause/cancel active work and wait for termination status, then:

```sh
omp plugin disable omp-intent-workflow
# Restore registration/enablement without replacing global settings:
omp plugin enable omp-intent-workflow
```

Restart/reload OMP after a lifecycle change. These operations leave the cmux extension, unrelated settings, credentials, original project changes, run databases and result worktrees intact. `bun scripts/plugin.ts status|install|disable|enable` wraps the same native lifecycle and stores only this plugin's public installation identity.

No provider performance, universally correct semantic interpretation, instantaneous interruption, OS confinement, or native Agent Hub registration of SDK workers is claimed without corresponding evidence.

The local native TUI smoke evidence is retained in `.workflow/native-installed-ui-proof.json` (planning/cancellation) and `.workflow/native-execution-proof.json` (exact-revision approval, actual Terra implementation, passing host checks and independent final review, executable delivery, clean shutdown and preserved native settings). These are actual installation checks, not a substitute for the fourteen-scenario acceptance report.

Completed local acceptance: `.workflow/verification/run-cdPwDo/report.json` records all fourteen scenarios passing in one `./scripts/verify-workflow` run. Its `scheduling/report.json` records one successful sequential sample (109,955 ms, peak 1 native worker session) and one parallel sample (69,029 ms, peak 3); these are measurements, not a general performance guarantee.
