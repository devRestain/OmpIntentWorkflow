# OMP 구현 경계와 기능 확인표

확인일: 2026-11-10, Asia/Seoul. 이 파일은 구현 인계용 조사·설계이며 설치되거나 실행된 extension이 아니다.
공식 저장소 `main` 문서와 공개 release를 확인했다. 관측한 최신 release는 `v18.18.6` (`9058ab9`, 2026-11-10 08:30 KST)다. 설치 버전의 실제 타입·기능·설정은 실행 환경에서 다시 확인해야 한다.

## 1. 이번 요구에 대한 구현 선택

OMP의 UI, 모델·provider 연결, 도구, persisted session을 재사용한다. 개인 workflow package가 기획 revision, 사용자 입력 원문, 승인 receipt, steering 전달 상태, 작업 배정, Git worktree와 통합 권한을 소유한다. 해당 package는 OMP 내부 타입에 의존하지 않는 core와 얇은 OMP adapter로 나눈다.

기본 경로는 두 가지이며 실제 기능 확인 후 선택한다.

| 실행 단위 | 우선 경로 | 선택 이유 |
|---|---|---|
| 읽기 중심의 독립 조사·검토 | native Task | 기존 하위 세션·관찰 UI·작업 메시징을 재사용하기 쉽다. |
| 사용자가 명시적으로 원하는 Git linked worktree에서 구현 | 실제 worktree cwd에 연결한 OMP SDK/RPC worker | native `isolated:true`가 Git linked worktree라는 보장이 없으므로 실제 요구를 충족하는 경로가 필요하다. |
| 설치 OMP가 실제 linked worktree child cwd·중단·steering·통합 전 검사까지 제공 | native 경로로 대체 가능 | 같은 계약을 충족하면 별도 worker adapter를 줄인다. |

SDK/RPC 보강은 새로운 provider runtime을 만드는 일이 아니다. OMP 세션을 지정 cwd에 생성하고 메시지·상태·중단을 연결하는 작은 실행 adapter다. 외부 세션이 native Agent Hub에 자동 등장한다고 가정하지 않는다. package의 작업 상태 UI에서 native child와 별도 worker를 함께 보여 주며, 검증된 공개 연동점이 있을 때만 Hub에도 연결한다.

## 2. 확인한 native 기능과 넘겨짚지 말아야 할 경계

### 2.1 대화형 기획

OMP에는 `/guided-goal` interview와 plan/review 흐름이 있다. 이번 설계의 기준은 **사용자가 특정 기획 revision을 확정해야 구현을 시작한다**는 계약이다. guided-goal의 존재만으로 이 계약이 충족된 것으로 보지 않는다. native plan review를 재사용하되, 사용자 확정과 모델이 작성한 goal/plan 상태를 구분한다.

공식 extension 문서는 TUI에서 `ctx.sessionModes`, `openPlanReview`, `resolvePlanReview`, `plan_review_requested`와 `plan_review_resolved`를 제공한다. `sessionModes`는 RPC·ACP·print·subagent에서 사용할 수 없다. `plan_review_requested.planContent`는 picker가 실제 실행하는 최종 내용과 달라질 수 있다. 사용자가 overlay에서 편집하거나 승인 직전에 파일 내용이 바뀔 수 있기 때문이다. 따라서 요청 이벤트에서 미리 계산한 hash를 승인 hash로 재사용하지 않는다.

**구현 규칙:** 승인 시점의 실제 내용으로 immutable `PlanRevision`을 만들고 사용자 이벤트·revision·hash를 묶는다. 문서의 `execute`, `compact`, `keep`는 approval choice지만 `refine`, `save`, 취소, pause, plan exit는 승인이 아니다. 설치 API로 승인된 내용과 이벤트를 원자적으로 연결할 수 없다면 package가 소유한 확정 UI/명령을 사용한다. 확정되지 않은 revision의 구현 dispatch는 host가 거절한다. `--plan-yolo`나 `ask` timeout 자동 선택으로 사용자 확정을 대체하지 않는다.

`v18.18.6`에는 미승인 plan의 pause가 승인·구현 계속으로 잘못 안내되던 문제의 수정이 포함된다. 이 기능을 쓰는 설치 환경에서는 해당 수정 여부를 기능 검사에 넣는다. 단순 버전 번호만으로 경계 검증을 생략하지 않는다.

근거: [Extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md), [guided-goal 회귀 테스트](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/test/goals/guided-goal.test.ts), [v18.18.6 release](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.6).

### 2.2 원문 수신과 steering

main `input` hook은 TUI와 RPC ingress를 다루지만 모든 입력 경로를 덮지 않는다. focused subagent 입력은 main input hook을 거치지 않으며, programmatic/synthetic/print/ACP 경로도 별도 확인이 필요하다. `before_agent_start`는 queue에 넣을 때가 아니라 실제 사용자 작업을 dequeue할 때 동작한다. 따라서 이 hook을 최초 수신 확인으로 쓰지 않는다.

native Agent Hub는 child 채팅·steer·revive·kill을 제공한다. RPC에는 `steer_subagent`와 `cancel_subagent`가 있다. child 직접 steering은 child transcript에 저장되고 parent에는 원문이 자동 전달되지 않는다. 성공 응답은 메시지 접수이며 이해·적용·완료의 증거가 아니다. `interruptMode: immediate`도 협력적 중단이다. 이미 시작한 모든 외부 작업을 즉시 중단하거나 되돌린다는 뜻이 아니다.

**구현 규칙:** main·worker 대상 사용자 입력을 모두 canonical ingress로 먼저 기록한다. raw 원문, 이벤트 ID, 수신 순서, 대상, 의도 변경 여부를 보존한 뒤 해당 worker로 전달한다. native 직접 입력을 포착할 수 없는 설치 경로는 전역 의도 보존의 적용 경로로 표시하지 않는다. 그 경우 자연어를 받는 package steering UI 또는 host RPC ingress로 연결하고, 직접 child 채팅의 지원 범위를 눈에 보이게 표시한다. 사용자에게 별도 JSON 작성은 요구하지 않는다.

수신 즉시 원문 기록과 영향 작업의 새 실행·통합 차단을 먼저 적용한다. 모델의 수정 해석을 기다리는 동안 이전 지시로 결과가 채택되지 않게 한다. worker가 새 revision을 context에 적용하고 확인한 뒤 계속한다. 실행 중 비중단 도구는 `stopping` 상태로 보여 주고 완료 후 효과를 확인한다. 불확실한 결과는 자동 재시도하거나 합치지 않는다.

근거: [Extension input 경계](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md), [RPC steering 및 queue semantics](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md), [Agent Hub](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md), [Agent steering API](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/README.md).

### 2.3 Git worktree와 native isolation은 동일하지 않다

native Task의 `isolated:true`는 별도 checkout을 요청한다. 현재 backend는 PAL 복제/overlay/ovnfs 계열이며 `isolation.backend: worktree`는 현행 설정값이 아니다. settings migration 문서는 과거 `worktree` 값을 `rcopy`로 옮긴다. `task.isolation.merge: branch`는 branch commit과 cherry-pick을 통한 결과 반영 전략이다. 그 이름만으로 worker의 작업 cwd가 Git linked worktree라고 판단하지 않는다.

**구현 규칙:** 사용자 요구의 기본 구현 backend는 실제 `git worktree add`로 만든 linked worktree다. `git worktree list --porcelain`, 각 cwd의 `git rev-parse --show-toplevel`, `--git-common-dir`, HEAD/branch를 확인해 소유권과 base commit을 기록한다. native isolation 대체를 제안할 수 있지만 사용자 동의 없이 이 요구를 조용히 바꾸지 않는다. 환경에 ovnfs가 있으면 native prompt가 별도 checkout 생성 방식을 바꿀 수 있으므로 유효 설정과 prompt도 확인한다.

native isolated 작업을 함께 쓰는 경우 `task.isolation.apply=false`로 결과 자동 반영을 막고, workflow 통합 단계에서 current revision·작업 범위·검증 증거를 확인한 뒤 반영한다. 이는 들어오는 파일이나 입력 의도를 제어하는 설정이 아니다. linked worktree worker도 같은 통합 경계를 따른다. 공유 `local://` artifact root에 worker가 같은 파일명을 덮어쓰지 않도록 실행 ID별 namespace를 부여한다.

근거: [Task isolation, lifecycle, artifact 문서](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md), [Settings migration](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md).

### 2.4 SDK/RPC worker adapter

OMP SDK의 `createAgentSession`은 `cwd`를 지정할 수 있고 `prompt`, `steer`, `followUp`, `abort`, event subscription과 persisted session을 제공한다. 한 process에서 여러 top-level session을 만들 때는 각 session의 private `AgentRegistry`가 필요하다. helper session은 `bindProcessState:false` 같은 공개 옵션으로 host의 process 설정 소유권에 간섭하지 않도록 구성한다. loaded extension instance를 공유하지 말고 session별로 factory를 재바인딩한다. 정확한 옵션은 설치 타입을 따른다.

별도 process를 쓰면 작업별 cwd로 OMP RPC를 실행하고 host가 프로세스 수명·입력·중단·회수·기록을 관리한다. 프로세스 분리는 cwd와 실행 격리에 유리하지만 provider/runtime 자체를 다시 만들 필요는 없다. worker마다 자기 작업 공간과 session을 쓰고, canonical workflow ledger에는 host만 기록한다.

새 worker는 bootstrap 자동 설치를 재실행하지 않아야 한다. main UI의 대화형 기획 진입과 worker의 이미 확정된 배정 수신을 구분한다. 전체 controller history를 child에 복사하지 않는다. scope에 맞는 최신 의도, 관련 원문 excerpt, API 계약, base commit, acceptance criteria만 제공한다. 필요하면 artifact를 조회하게 한다.

근거: [OMP SDK](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md), [OMP RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).

## 3. Extension을 적용할 위치

아래는 이번 설계의 적용 지점이다. API의 존재가 전체 계약의 구현 완료를 의미하지 않는다.

| 적용 지점 | package 책임 |
|---|---|
| 검증된 입력 ingress | 원문을 먼저 보존하고 event ID로 중복 전달을 제거한다. steering과 일반 질문을 구분한다. |
| 기획 UI/확정 동작 | 사용자와 revision을 연결한 승인 receipt를 만든다. 모델 생성 문자열은 receipt가 될 수 없다. |
| `before_agent_start` | 현재 배정과 최신 accepted revision을 적용한다. 재진입·revive에 idempotent하게 동작한다. |
| `context` | provider context만 필요한 내용으로 구성한다. persisted 원문을 덮어쓰지 않는다. |
| `before_subagent_spawn` | 지원되는 native child의 model route/dispatch 허용을 판단한다. |
| `tool_call` 및 worker adapter 실행 전 | 현 배정·revision·worktree 소유권과 phase를 확인한다. 이미 실행 중인 tool의 취소와는 구별한다. |
| 작업 결과 수신 | 검증 증거와 reference만 작은 Result로 전달하고 전체 로그는 artifact에 둔다. async completion 경로도 검사한다. |
| integration transaction | 최신 승인, pending steering, 작업 범위, base와 commit identity, validation을 확인하고 반영한다. |
| resume/fork/rollover | branch에 맞는 canonical 상태로 context를 재구성한다. old lease와 old completion을 재사용하지 않는다. |

`ctx.invokeTool`은 같은 이름의 native 도구를 shadow하는 wrapper에 한정된다. 새 도구가 임의 native Task를 호출하는 범용 dispatcher라고 가정하지 않는다. `before_provider_request`는 transport 적용 범위가 있으므로 그것만으로 보편적 enforcement를 주장하지 않는다. `context` projection은 tool call/result의 ID·순서와 provider replay 형식을 유지한다. UI renderer만 줄이면 provider context는 줄어들지 않는다.

원문 사용자 메시지·도구 출력은 출처를 유지하는 데이터다. hook을 통해 더 높은 신뢰 수준의 지시로 올리지 않는다. 기존 프로젝트 규칙을 context 절약 명목으로 누락하지 않는다.

## 4. 병렬성·모델·과추론 설정의 의미

native Task의 현재 `task.maxConcurrency` 기본값은 32이며 0은 무제한이다. 이는 실제 하드웨어에서 권장하는 값이라는 뜻이 아니다. 별도 RPC/SDK worker를 만들면 native session semaphore가 모든 worker를 함께 제한한다고 가정하지 않는다.

workflow scheduler는 준비된 독립 작업을 적극 실행한다. 작업별 모델 호출 수를 낮추려는 목적의 낮은 동시성 제한을 새로 만들지 않는다. CPU/RAM·provider rate limit·테스트 자원·port·DB·통합 병목은 처리량을 위해 관찰하고 조절한다. 가격·token 수가 많다는 이유만으로 병렬 구현을 중단하지 않는다.

`task.perCallModel`, `task.enableEffort`, `task.structured` 등의 활성 조건을 설치 schema에서 확인한다. 문서에 보이는 `model`·`effort` 필드가 모든 기본 설치에서 허용된다고 가정하지 않는다. `solutionSpace`는 작업량보다 원인·설계의 열린 정도를 표현한다. 이미 확정된 큰 구현을 매번 최대 effort로 재설계하게 하지 않는다.

기존 사용자가 지정한 `session.warnCost`/`session.maxCost`는 존중하되 이번 요청을 근거로 새로운 총 token·금액 상한을 강제하지 않는다. native cap은 in-flight 초과 가능성·집계 제외 범위가 있으므로 절대 global budget으로 표현하지 않는다. 과추론 억제는 정보가 달라지지 않은 조사 반복, 확정된 결정의 재개방, 근거 없는 검토 반복을 감지하는 별도 정책이다.

## 5. 설치 환경의 필수 capability probe

아래 검사를 임시 저장소와 무해한 fixture로 수행한다. 미통과 기능을 실행 가능한 것처럼 보고하지 않는다. 기존 환경의 provider 비용을 숨기는 mock 성공으로 대체하지 않는다.

1. **기획 gate:** draft, save, pause, exit, refine에서 구현이 시작되지 않는다. 사용자의 확정한 revision만 시작한다. review 중 수정·재개·중복 click이 잘못된 revision을 승인하지 않는다.
2. **원문 ingress:** main 입력, 실행 중 steering, focused child, RPC 입력을 각각 보내 기록 위치와 원문·순서를 확인한다. 지원하지 않는 경로는 adapter로 보완한다.
3. **전달 의미:** 수신·queue·worker context 적용·ack를 별도 관찰한다. 늦은 ack, offline/parked/revived worker도 재배정 전에 최신 의도를 받는다.
4. **실제 worktree:** 두 개 이상 linked worktree worker가 서로 다른 cwd/branch에서 동시에 실행된다. native isolation label을 검증 근거로 대신 쓰지 않는다.
5. **변경 중단 경계:** worker가 tool 호출 중일 때 steering을 보내 새 작업·통합을 차단한다. 취소 못 하는 진행 작업은 그 상태를 명시하고 결과를 격리한다.
6. **결과 통합:** stale revision, stale assignment generation, 중복 completion, 바뀐 base, pending steering 결과는 채택되지 않는다. unrelated 결과 재사용은 영향 없음 근거로 명시한다.
7. **컨텍스트:** child 로그가 main context를 채우지 않으며 필요한 근거 조회가 가능하다. model change/compaction/resume 후 최신 제약을 실제 provider 입력에서 확인한다.
8. **실행 상태:** foreground `agent_end`만으로 전체 완료를 선언하지 않는다. pending jobs와 delayed completion을 추적한다. process 재시작 후 미확정 통합을 복구한다.
9. **병렬 처리량:** 독립 작업은 가능한 한 겹쳐 실행되며 shared file, 테스트 port, DB, build 자원 충돌은 제한하거나 독립화한다. 완료한 조사 재반복 없이 병목 원인을 확인한다.
10. **사용자 인수:** 자연어로 기획 수정·확정·부분 steering·pause/resume을 수행하고 현재 적용 revision과 worker 상태가 이해 가능하게 표시된다.

완료 보고에는 통과한 경로·실제 adapter 선택·설치 버전·남은 제약을 적는다. 여기서 제시한 기능 검사를 아직 수행한 것으로 서술하지 않는다.
