# 구현과 인수 평가

## 1. 배치할 코드의 책임

다음은 제안 구조다. native OMP 설정 key나 이미 존재하는 package가 아니다. 실제 저장소의 언어·빌드 방식에 맞추되 책임과 정본 소유권은 유지한다.

| 모듈 | 책임 |
|---|---|
| intent/control | 원문·draft·승인·변경 순서·scope epoch·pause/cancel |
| context | 현재 작업의 원문/제약/근거 view 생성 |
| work | DAG·ready 작업·시도·전달/ack·결과 상태 |
| git | linked worktree 생성/검증·후보·통합 gate·복구 |
| adapter/omp | 모델·세션·cwd·도구·입력·취소·completion 연결 |
| ui | 기획 수정·확정·현재 작업·steering 반영 상태 |
| evidence | 실제 검사·commit·원문 기준 검토·관측 usage |

이것은 책임별 코드 모듈이며, 일곱 개의 서버나 일곱 개의 상시 agent를 뜻하지 않는다. core reducer·state interface·git와 adapter를 테스트 가능한 경계로 분리한다.

## 2. 어댑터의 의미 계약

아래 이름은 제안한 내부 interface이며 native API 이름이 아니다.

```text
startWork(work, exactCwd, context, model) -> handle
deliverSteering(handle, eventSet, currentAssignment) -> deliveryReceipt
observeAcknowledgement(handle) -> ackSet + assignmentId
requestStop(handle, reason) -> requested | stopped | unknown
observeEffects(handle) -> artifacts + known external effects
getResult(handle) -> Result
reconcile(handle, persistedState) -> actual status
```

`deliveryReceipt`와 `ackSet`을 분리한다. 현재 provider/tool batch가 끝난 뒤에야 steer가 들어가는 경우 그 지연을 표시한다. external SDK worker가 native Task registry·Agent Hub·cost limit에 자동 포함된다고 가정하지 않는다. 해당 기능을 연결했는지 보고한다. [S4, S6, S8, S9]

다중 top-level SDK 세션을 쓸 때 registry·process state·extension discovery·resource loading·tool allowlist의 실제 API를 설치 버전에서 확인한다. `toolNames`만 제한했다고 모든 native/custom tool이 차단된다고 추정하지 않는다. child별 정책이 실제 실행에 적용되는지 probe한다. [S6]

## 3. 구현 순서

### A. 환경 조사와 기획

OMP/Git/runtime 버전, 기존 extensions, 입력 경로, 실제 model 목록, 테스트 명령, 미커밋 변경을 확인한다. raw secrets를 기록하지 않는다. 사용자가 구체적인 설치 기획을 확정할 수 있게 한다.

### B. 작지만 실제인 end-to-end 경로

기획 두 번 수정 → 확정 → 두 worktree → 각 세션 실행 → 한 작업의 steering → stale 결과 보류 → 최신 검사/통합 → 재시작 대조. 이 경로로 native 경계와 필요한 SDK/RPC 보완을 결정한다. Native로 불가능한 경로를 prompt만 강화해 해결됐다고 하지 않는다.

### C. 병렬 배정과 context

의존 작업을 연결하고 준비된 작업을 적극 배정한다. 큰 로그·조사는 작업별 context에서 처리하며 관련 원문은 보존한다. 모델 선택은 의미 있는 경계에서만 수행한다.

### D. 사용자 경험과 복구

자연어 개입, 상태 표시, 특정 작업 확인, 전체/부분 pause, 명시적 resume, 늦게 온 결과, process 종료·재시작, 실제 worktree 정리를 완성한다. 설치를 다시 실행해도 같은 설정을 중복 추가하지 않는다.

### E. 필요한 실제 성능 비교

대표적인 큰 작업 하나부터 의도 준수와 전체 완료 시간을 비교한다. 작업량·기준 commit·모델·검사·완료 정의를 기록한다. 더 많은 사례는 구체적인 불확실성을 해소할 때만 추가한다.

## 4. 인수 기준

| 영역 | 통과 조건 | 실패 사례 |
|---|---|---|
| 기획 | 실제 승인 대상과 dispatch snapshot 일치 | draft를 보여 주고 새 내용으로 실행 |
| 개입 | 긴 worker 실행 중에도 host가 입력 기록/상태 표시 | 모든 Task가 끝날 때까지 입력 대기 |
| 전달 | 관련 변경 전부의 확인 상태를 추적 | #42 확인으로 #41 누락을 덮음 |
| 영향 범위 | 국소 변경에 무관한 작업 유지 | 작은 UI 변경에 전 작업 초기화 |
| actual worktree | Git 목록·cwd·branch·base를 확인 | 복사 디렉터리를 worktree라고 보고 |
| 통합 | 현재 요구·epoch·입력·commit·검증을 비교 | 과거 조건의 성공을 최신 성공으로 채택 |
| races | 새 입력/통합 HEAD 변경 시 마지막 gate 재검사 | 테스트 시작 때의 상태만 확인 |
| 외부 효과 | 중단 요청과 실제 종료를 구별 | abort 호출만 보고 모든 실행 종료 선언 |
| 복구 | writer·세션·Git 실물 대조 후 진행 | paused run을 자동으로 새 작업으로 시작 |
| 원문 의미 | compiled spec과 별도로 결과 적합성 검사 | 잘못 번역한 완료 기준만 충족 |
| 병렬성 | 독립 ready 작업을 실제로 동시 실행 | 낮은 비용 상한으로 준비된 일을 계속 대기 |
| 과추론 | 새 증거·결정 변화 없는 반복 제거 | 남은 목표 없는 review loop |

동작 전제는 지원되는 ingress와 실행 어댑터에 한정한다. 우회 입력이나 임의 외부 프로세스를 포함한 강한 보장을 주장하려면 그 경로도 실제로 연결·검증해야 한다.

## 5. 관측 지표

시간의 기준은 host의 단조 시각과 이벤트 순서다. 서로 다른 프로세스/시계의 wall clock만으로 순서를 단정하지 않는다.

| 지표 | 해석 |
|---|---|
| 기획 확정 전 재해석·수정 | 사용자가 원하는 기획에 도달하는 과정; 적을수록 무조건 좋다는 뜻 아님 |
| received → recorded/fenced | 입력이 보존되고 오래된 실행 조건이 막히는 지연 |
| recorded → delivered/ack | 대상 worker 전달과 확인 지연; in-flight 대기 구분 |
| ack → 실제 결과 반영 | 메시지 확인과 제품 변경 사이의 간격 |
| 누락/오채택 | 관련 event 누락, stale result 채택, 잘못된 승인 |
| 전체 완료 시간 | 기획 확정 후 구현·검증·통합까지의 wall time |
| 준비된 작업의 대기 | 의존성, provider, local resource, scheduler 중 원인 구별 |
| 통합 재작업 | 충돌·잘못된 인터페이스·outdated input이 만든 추가 작업 |
| 불필요한 반복 | 새 evidence/입력/방법 변화 없는 재시도·검토 |
| context 상태 | 상위 활성 context와 원문 제약 회복 가능성 |
| 누적 사용량 | 모든 관측 가능한 모델/side requests; unknown 분리 |

접수 지연과 실제 반영 지연을 합쳐 하나의 “steering 속도”로 보고하지 않는다. 초 단위 SLO는 로컬 측정 후 설정한다. “항상 1초” 같은 미검증 숫자를 기본 약속으로 넣지 않는다.

## 6. 비교 방법

순차 기준과 병렬 경로는 같은 사용자 목표·repo input·완료 조건을 사용한다. 기능 수·검증 강도를 줄여 얻은 속도 향상은 성공으로 세지 않는다. 같은 작업을 다시 풀며 얻은 사전 지식, warm cache, 모델 차이를 기록한다.

가능하다면 동일 작업군에서 실행 순서를 바꾸거나 동등한 과제를 사용한다. pilot 한 번의 결과를 일반적인 배수 향상이나 무오류율로 발표하지 않는다. 총토큰이 늘더라도 원문 준수와 완료 시간이 개선되면 이번 사용자의 선호에 부합할 수 있다.

회귀 fixture는 핵심 제어 순서와 오류 처리를 검사한다. 자연어 의미 판단의 정답, 모든 Git 장애, 모든 provider 중단 행동을 증명하지 않는다. live model·실제 OMP·실제 Git 통합 검사는 별도 결과로 남긴다.

## 7. 설치 완료 보고에 포함할 것

- 확인한 설치 버전, native 기능과 추가 구현의 구분.
- 실제 변경 파일과 설정, 기존 사용자 수정의 보존 방법.
- 기획을 시작·수정·확정하고 실행 중 개입하는 예시.
- 지원하는 ingress/worker 경로와 미지원 경로.
- 실제 worktree와 모델 세션, 검증·통합의 근거.
- 테스트 결과, not_run, 남은 한계와 영향.
- 현재 run 복구, 확장 비활성화, 설정 되돌리기 방법.

파일 생성·mock 통과·reference 통과만으로 실제 환경 구축이 끝났다고 보고하지 않는다.
