# pi에서 시작할 것인가, OMP를 확장할 것인가

확인일: 2026-11-10 (Asia/Seoul). 이 문서는 사용자의 최신 요구를 기준으로 한 구현 선택 제안이다. 성능 벤치마크나 설치된 로컬 환경의 기능 확인 결과는 아니다.

## 1. 권고

**현재는 OMP를 사용자 접점과 에이전트 실행 기반으로 유지하고, 기획·의도 개정·병렬 작업·통합을 함께 책임지는 하나의 일관된 workflow extension을 만드는 편을 권한다.** 그 안에서 프레임워크에 의존하지 않는 상태·정책 코어와 OMP 어댑터를 분리한다. 실제 Git linked worktree를 관리해야 하는 구현 워커는 필요하면 OMP SDK/RPC로 실행한다.

이 권고는 OMP의 기본 Task만으로 모든 요구를 충족한다는 뜻이 아니다. 특히 **사용자 수정의 전파 확인, 오래된 결과의 통합 차단, 기획 버전에 연결된 실행 허가, 실제 Git linked worktree 수명주기**는 이번 워크플로우가 직접 소유해야 할 가능성이 높다. 반대로 모델 연결·인증·기본 도구·세션 실행까지 다시 만들 이유는 없다.

사용자는 이미 OMP를 일상 작업의 기반으로 삼고 있고, 당장의 목적은 프레임워크 자체를 개발하는 것보다 그 위에서 큰 기획을 정확하고 빠르게 구현하는 것이다. 이 조건에서 OMP의 기존 사용 경험을 보전하고 부족한 제어 경계만 추가하는 것이 합리적이라는 **설계 판단**이다. 실제 구현 난이도와 성능은 아래의 작은 통합 검증으로 판정한다.

## 2. 현재 공식 자료에서 확인한 사실

### pi

기존 `badlogic/pi-mono` 주소는 현재 공식 `earendil-works/pi` 저장소로 이동한다. 현재 README는 패키지를 `@earendil-works/pi-coding-agent`로 안내하고, 기본 제품에는 subagent와 plan mode를 넣지 않는다고 명시한다. 따라서 과거 패키지명과 예제를 그대로 가정하지 말고 설치된 버전의 실제 exports를 조사해야 한다. [P1]

pi에서 이 기능들을 만들 수 없다는 뜻은 아니다. 공식 예제에는 `plan-mode/`, `subagent/`, 질문 UI, handoff, 사용자 메시지 주입, Git checkpoint 등이 있다. 예제를 설치·수정하는 경로도 가능하다. 다만 예제의 존재와 이번 요구에 필요한 중단·복구·통합 보장이 완성되어 있다는 주장은 구분한다. [P2]

공식 SDK의 `createAgentSession()`은 모델·도구·리소스·세션 관리자를 주입할 수 있고 `cwd`로 작업 경로를 지정한다. 세션은 기본적으로 지속되며, `steer()`와 `followUp()`은 다른 전달 시점을 가진다. 현재 문서에서 steering은 현재 assistant turn과 그 tool 실행 이후에 반영된다. `abort()`는 활성 작업 중단 후 idle을 기다린다. **메시지를 큐에 넣었다는 사실은 여러 워커가 새 의도를 반영했다는 확인이 아니다.** [P3]

확장 API에는 input 변환, 매 모델 요청 전 context 조정, 도구 호출 개입, 대화형 UI, 모델 context에 들어가지 않는 `appendEntry` 저장이 있다. 이들은 사용자 중심 워크플로우를 만들 충분한 확장 지점이며, 어떤 프레임워크를 고르든 canonical state·검증된 전파·최종 통합은 별도 설계가 필요하다. [P4]

### OMP

OMP는 native Task·병렬 실행·모델 선택·격리 작업·세션 실행·대화형 계획 관련 기능을 이미 제공한다. 그러나 기술 문서의 `isolated: true`는 현재 PAL/복사·오버레이 계열 또는 ovnfs 작업공간을 사용할 수 있다. **독립 checkout이라는 설명만으로 `git worktree list`에 나타나는 linked worktree를 보장할 수 없다.** isolation의 patch/branch 통합 정책도 사용자의 의도 개정과 연결된 통합 허가를 대신하지 않는다. [O1]

OMP SDK에는 `cwd`를 명시하는 세션 구성, `steer`·`followUp`·`abort`, 리소스와 도구 선택이 있다. 같은 프로세스에서 여러 top-level 세션을 실행할 때는 각 세션에 private `AgentRegistry`가 필요하며, 보조 세션의 프로세스 상태 결합은 `bindProcessState: false` 등 실제 옵션을 확인해야 한다. `toolNames`만으로는 허용 목록이 되지 않는다. `restrictToolNames` 등의 정확한 계약을 따른다. [O2]

확인한 최신 release는 pi `v1.5.1` (`dd30101`), OMP `v18.18.6` (`9058ab9`)다. OMP 릴리스에는 미승인 계획을 pause할 때 승인된 것으로 이어서 실행하던 상태 처리의 수정이 포함된다. 이 사례는 기획 확정과 실행 전환을 문구로만 구현하지 말아야 하는 이유를 보여 준다. `main` 문서의 모든 기능이 이 release나 사용자 설치본에 동일하게 들어 있다고 가정하지 않는다. [P5][O3]

## 3. 요구별 비교

아래에서 “직접 구현”은 모델·도구를 처음부터 만든다는 뜻이 아니라, 해당 정책과 상태 전이를 소유하고 검증한다는 뜻이다.

| 요구 | OMP 기반 | pi 기반 | 이번 선택 |
|---|---|---|---|
| 대화로 기획을 수정하고 명시적으로 확정 | 기존 계획/질문 기능을 활용하되 의도 원문·기획 revision·승인 바인딩 추가 | 공식 plan-mode/질문 예제를 출발점으로 자체 흐름 구성 | OMP 사용자 접점 재사용 |
| 중간 자연어 steering | native 메시지 경로 활용 가능; 워커별 전달·적용 확인과 영향 범위 계산은 추가 | 세션 steering API 활용 가능; 동일한 전파 계층 필요 | 중립 코어가 steering 사건과 적용 상태 소유 |
| 실제 Git linked worktree 병렬 구현 | native isolation과 구분; 부족하면 worktree manager + OMP worker session | worktree manager + pi worker session을 구성 | 같은 worktree manager를 재사용할 수 있게 설계 |
| 원문과 최신 기획에 맞는 맥락 | native session/context hook에 기록의 projection 주입 | session/context hook으로 동일 정책 구현 | 문맥 조립 로직은 프레임워크 밖의 순수 로직으로 유지 |
| 중단·재시작·오래된 결과 차단 | native lifecycle을 활용하되 별도 revision/result 통합 검사 필요 | 세션 lifecycle 위에 동일 검사 필요 | 프레임워크가 준다는 가정 없이 회귀 검증 |
| 사용자에게 병렬 작업 상태 표시 | native Task는 Hub를 활용 가능; SDK/RPC 별도 워커의 자동 등록은 보장하지 않음 | 자체 status/widget/대시보드 구성 | 최소한의 일관된 workflow 상태표 제공 |
| 모델·인증·개발 도구 설정 | 현재 OMP 환경을 이어 사용 | pi의 도구·provider 환경으로 이행 | 실제 불편이 발생하기 전 재이행 비용을 지불하지 않음 |
| 추후 AgentFabric 통합 | OMP 어댑터를 실행 backend 중 하나로 사용 | pi 어댑터를 실행 backend 중 하나로 사용 | 하나의 상태·정책 코어, 교체 가능한 실행 어댑터 |

OMP가 기능 수가 많다는 사실은 이번 요구를 더 정확하게 구현한다는 증거가 아니다. pi가 작다는 사실도 더 빠르거나 덜 고장 난다는 증거가 아니다. 선택 기준은 **필요한 행동을 공식 인터페이스로 통제할 수 있는가, 그 행동을 검증하는 데 어느 쪽이 적은 중복 구현을 요구하는가**다.

## 4. 권장 구현 경계

하나의 package 안에 다음 책임을 분리한다. 처음부터 별도의 서버나 여러 저장소로 나눌 필요는 없다.

| 부분 | 소유하는 책임 | 소유하지 않는 책임 |
|---|---|---|
| Workflow core | 원문·기획 revision·사용자 확정·steering 사건·작업 의존성·결과 수용 조건·맥락 조립 | provider 인증과 모델 transport |
| Git workspace manager | 실제 linked worktree 생성·소유권·기준 commit·브랜치·통합 순서·복구·정리 | 사용자가 원한 목표의 의미 판단 |
| OMP adapter | 입력/UI, 모델 실행, 지원되는 steering/abort, 세션 기록·이벤트 변환 | 원본 의도나 기획을 다른 버전으로 독자 갱신 |
| 향후 pi adapter | 같은 실행 계약을 pi SDK/RPC로 제공 | 독립된 두 번째 scheduler와 기획 원장 |

SDK/RPC 워커 경로를 쓰면 native Task와 다른 부분을 명시한다. 특히 Agent Hub 표시, async 결과 전달, 비용 집계, 재개, skill/context discovery, 종료 시 정리 같은 기능이 자동으로 공유된다고 가정하지 않는다. 필요한 기능만 연결하고, 구현하지 않은 것은 상태 화면과 인계 문서에서 정확히 표시한다.

외부 워커의 progress를 native Hub에 억지로 맞추려고 private registry 내부를 고치는 것보다, 공식 UI 확장으로 작업·revision·진행 상태·steering 반영 여부를 보여 주는 편이 단순할 수 있다. 이 선택은 설치본의 공개 API 조사 후 결정한다.

이 구조에서는 초기 OMP 구현의 의도 정책, 스케줄링 기준, worktree 관리, 검증 fixture를 pi/AgentFabric에서도 재사용할 수 있다. 단, OMP와 pi의 런타임 객체·세션 파일·extension API가 서로 그대로 호환된다고 약속하지 않는다.

## 5. pi로 바로 시작하는 편이 더 나은 조건

다음 조건이 확인되면 OMP를 유지한다는 선입견을 버리고 pi 어댑터를 우선할 수 있다.

1. **핵심 실행 경계를 공개 API로 통제할 수 없다.** 입력 접수, worker별 실행, 자동 적용 차단, 취소, 결과 수용 중 필요한 경계가 막혀 있다. 먼저 제한된 SDK/RPC 어댑터로 해소되는지 확인한다.
2. **OMP 내부 수정이 여러 곳으로 확산된다.** registry, task scheduler, UI, session lifecycle을 함께 patch해야 한다면, 얇은 확장의 이점이 사라진다.
3. **기존 기능의 대부분을 우회하게 된다.** 자체 UI·scheduler·worktree·session registry를 모두 만들고 OMP를 모델 호출 backend로만 남긴다면 pi의 더 작은 표면을 택할 이유가 커진다.
4. **AgentFabric가 이미 실행 제어의 소유자다.** 그 안에 OMP와 별도의 중복 scheduler를 유지하기보다 pi 세션을 worker runtime으로 쓰는 것이 경계가 더 명확할 수 있다.
5. **동일 fixture에서 pi가 관리하기 쉬운 구현을 보여 준다.** 취향보다 plan 확정, steering, stale result 차단, 재시작 복구 테스트를 기준으로 전환한다.

반대로 “완벽히 나만의 도구를 만들 수 있으니 처음부터 pi”는 충분한 근거가 아니다. 제어 자유에는 오류 처리와 통합 시험의 소유권이 따른다. 플러그인을 따로따로 추가하면 각 플러그인이 계획·대기열·취소·맥락을 별도로 관리하여 초기 의도 손실을 다시 만들 수 있다. **pi를 고르더라도 기능마다 서로 독립된 상태 원장을 만드는 방식은 피하고, 하나의 상태 계약을 공유하는 cohesive package로 구현한다.**

## 6. 결정을 구체화하는 첫 구현

첫 단계에서는 대규모 구현을 시작하기 전에 다음의 작고 실제적인 vertical slice를 OMP 위에서 완성한다.

- 대화로 계획을 두 번 수정한 뒤, 특정 revision을 사용자가 확정해야만 구현 워커가 시작된다.
- 서로 다른 두 linked worktree에서 워커가 실행되고, `git worktree list --porcelain`로 확인된다.
- 실행 중 한 작업에만 영향을 주는 steering을 접수하면 해당 작업의 다음 유효 실행과 결과 수용 조건이 바뀌며, 무관한 작업은 계속 진행한다.
- 이전 revision에서 늦게 도착한 결과는 자동 통합되지 않는다. 새 기획과 호환성을 재검증해 수용하거나 수정 대상으로 남긴다.
- 종료·재시작 후에도 승인 상태, 최신 의도, 작업별 revision, 미통합 변경을 복원한다.

이 slice가 공개 API와 좁은 어댑터로 구현되면 OMP를 계속 사용한다. 여기서 core patch나 불투명한 우회가 필요하다면, 같은 core와 fixture를 pi SDK에 연결하는 작은 비교 구현으로 판단한다. 비교 자체를 상시 이중 프레임워크 운영으로 확대하지 않는다.

실제 큰 작업에서는 준비된 독립 작업을 가능한 한 병렬로 실행한다. 어느 프레임워크를 골라도 작은 예산을 임의로 씌워 병렬성을 제한하지 않는다. 병렬성의 제한 근거는 의존성, 통합 충돌, provider 처리량, 테스트/빌드 자원, 시스템 응답성과 복구 가능성이다. 과추론 억제는 **새로운 관찰·판단·진전을 만들지 않는 반복**에 적용한다.

## 7. 공식 출처

- [P1: pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) — 현재 저장소·패키지·기본 제품 범위.
- [P2: pi extension examples](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md) — plan-mode, subagent, 질문·handoff 등 구현 출발점.
- [P3: pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) — session, cwd, prompting, steering, abort, 주입 경계.
- [P4: pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) — context/input/UI/appendEntry 등 확장 지점.
- [P5: pi v1.5.1](https://github.com/earendil-works/pi/releases/tag/v1.5.1) — 조사 시점 release 확인.
- [O1: OMP Task reference](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) — 병렬 Task, 격리 backend, patch/branch 적용 정책.
- [O2: OMP SDK](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md) — cwd·registry·세션 제어·도구 제한.
- [O3: OMP v18.18.6](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.6) — 조사 시점 release 및 미승인 plan pause 수정.

본문의 선택 기준과 권고는 위 기능에 근거한 설계 제안이며, 두 프레임워크의 속도·정확도·유지보수 비용을 실제 측정한 결과는 아니다.
