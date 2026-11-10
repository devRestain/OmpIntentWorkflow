# 출처와 적용 범위

확인일: 2026-11-10 (Asia/Seoul).

이 자료의 목표·프로토콜·구현 권고는 사용자의 요청에 맞춘 설계다. 아래 공식 문서에 같은 완성형 workflow가 내장됐다는 주장이 아니다. GitHub `main`은 변할 수 있으므로 실제 구현에서 설치 버전·types·설정과 대조하고 의존 버전을 기록한다.

## 공통 출처 표기

| ID | 공식 자료 | 이번에 확인한 범위 |
|---|---|---|
| S1 | [Felix Rieseberg — How to be more ambitious](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) | 상위 성과·원자료·전문가의 방법·다른 분야의 기법·외부 판단이라는 철학 |
| S2 | [OMP extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) | input/context/tool hooks, plan review, mode 제어와 입력 경계 |
| S3 | [OMP session](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md) | persisted session과 context, custom entry·branch 재구성 |
| S4 | [OMP Task](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md) | async Task, isolation, 모델·effort, 결과·artifacts·자동 적용 범위 |
| S5 | [OMP settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md) | 실제 설정 catalog, isolation migration, 동시성·비용 한도 |
| S6 | [OMP SDK](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md) | createAgentSession/cwd, registry, 설정·도구·세션 제어 |
| S7 | [Git worktree](https://git-scm.com/docs/git-worktree) | linked worktree, 공유 상태, branch, 관리·정리·제약 |
| S8 | [OMP RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) | steer/abort, subagent 입력과 상태·결과 |
| S9 | [OMP Agent Hub](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md) | native 작업자 상태와 focused child interaction |
| S10 | [pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) | 현재 upstream·package와 기본 제품의 범위 |
| S11 | [pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) | session/cwd/steering/abort와 주입 가능한 실행 경계 |
| S12a | [pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | context·입력·도구·UI·기록 확장 |
| S12b | [pi extension examples](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md) | plan-mode·subagent·질문 UI 등 구현 출발점 |
| S13 | [OMP v18.18.6](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.6) | 조사 시점 release와 미승인 계획 pause 처리 수정 |
| S14 | [pi v1.5.1](https://github.com/earendil-works/pi/releases/tag/v1.5.1) | 조사 시점 release |
| S15 | [Git update-ref](https://git-scm.com/docs/git-update-ref) | 예상 이전 값을 확인하는 ref 갱신; checkout 파일 동기화와 구별 |

OMP_CAPABILITIES와 PI_OR_OMP의 자체 source ID는 해당 파일 끝의 링크를 따른다. 공통 문서의 S 번호와 혼동하지 않는다.

## 중요한 확인과 그 의미

OMP의 native isolation과 Git linked worktree를 구분해야 한다. 설정 문서의 legacy `worktree → rcopy` 전환과 Task의 실제 workspace 경로를 확인했다. 따라서 실제 linked worktree 요구는 Git 명령·worker cwd·session 구성으로 검증하도록 했다. [S4, S5, S7]

main `input` hook이 focused-subagent 등 모든 입력 경로를 포착하지 않는다는 문서 경계를 확인했다. 기획 확정 UI의 최초 preview와 최종 승인 시 내용이 달라질 수 있다는 경계도 반영했다. 이 때문에 입력 원장·확정 snapshot·dispatch/integration gate를 제안했다. [S2, S8]

pi는 작은 확장형 기반을 제공하지만 기본 제품에서 subagent와 plan mode를 생략한다고 설명한다. 공식 예제가 있으므로 직접 구현이 가능하며, OMP 역시 사용자 요구 전체가 완제품으로 내장된 것은 아니다. 추천은 기존 환경과 필요한 추가 구현을 고려한 판단이다. [S10, S12b]

## 프로젝트 첨부 자료

| ID | 첨부 자료 | 사용한 범위 |
|---|---|---|
| AF1 | `ARCHITECTURE.md` — 현재 작업 사본 `project_sources/03-ARCHITECTURE.md` | 정적 Core와 Operation 소유 상태, local prototype 우선, 향후 실행 소유권 |
| AF2 | Core `README.md` — 현재 작업 사본 `project_sources/02-README.md` | Core 0.18.1 계약과 실제 실행·state의 구별 |
| AF3 | root `README.md` — 현재 작업 사본 `project_sources/01-README.md` | 프로젝트 맥락과 별도 구현 검증 필요성 |

첨부 파일을 실제 최신 저장소의 실행 상태로 간주하지 않았다. 이 작업에서는 프로젝트 원본을 수정하지 않았다. OMP 구축 이후 AgentFabric를 변경할 때 현재 repository manifest·state·실행 증거를 다시 확인한다.

## 이번에 입증하지 않은 것

OMP와 pi의 상대적인 실행 속도·정확도·유지보수 시간, 사용자 하드웨어의 적정 병렬 수, local System One의 한국어 판정 품질, 실제 steering latency, 의도 손실 확률, 총토큰 변화는 측정하지 않았다. in-memory reference 검사는 상태 규칙의 예시이며 실제 framework 통합·semantic fidelity의 증거가 아니다.
