# 실제 Git worktree를 이용한 병렬 구현과 통합

이 문서는 구현 요구다. 현재 환경에서 여러 OMP가 실행되었다거나 속도가 측정되었다는 뜻이 아니다. Git 동작의 근거는 공식 worktree 문서, OMP의 native 격리 차이는 OMP_CAPABILITIES를 따른다. [S4, S5, S7]

## 1. 병렬성의 목표

큰 기획에서는 준비된 독립 작업을 가용 역량까지 실행한다. 세션 수·총토큰이 늘어나는 것은 이 사용자의 허용된 선택이다. 병렬성이 실제 완료 시간을 줄이는지 판단하고, 결정을 바꾸지 않는 중복 분석은 중단한다.

총 작업량을 W, 의존성이 만드는 가장 긴 순차 경로를 L, 동시에 일을 처리하는 역량을 P라 하면 이상적인 실행 시간도 max(W/P, L)보다 짧아지기 어렵다. 실제로는 조정·도구 대기·통합·재검증 시간이 더 든다. 이 관계는 모델 성능 예측이나 측정한 속도 향상률이 아니다. 이미 순차 경로가 병목인데 준비되지 않은 세션만 늘리면 빨라지지 않는다는 설계 원리다.

작업 배정은 다음 순서를 따른다.

1. 현재 기획과 요구를 만족하는 완료 단위를 만든다.
2. 데이터·인터페이스·검증 선행조건을 연결해 DAG를 구성한다.
3. 준비된 작업 중 전체 완료를 막는 경로와 큰 불확실성을 먼저 해소한다.
4. 서로 독립적인 작업은 가능한 한 동시에 실행한다.
5. 결과가 도착하면 후속 작업을 바로 열고, 전체 wave가 끝날 때까지 불필요하게 기다리지 않는다.

## 2. 무엇을 나눌 것인가

WorkItem에는 다음을 구체적으로 넣는다.

| 항목 | 목적 |
|---|---|
| 결과와 완료 기준 | 작업자가 무엇을 완성했는지 판단 |
| 관련 요구 ID/version | 원래 목표와 최신 수정 연결 |
| 읽는 자료와 코드 | 필요한 문맥 및 입력 변경 영향 추적 |
| 쓰기 소유 범위 | 충돌 예방과 변경 범위 검사 |
| 입력·출력 인터페이스 | 파일이 달라도 생기는 의미적 의존 확인 |
| 의존 작업과 정확한 산출물 | 미완성 결과를 사실로 간주하지 않음 |
| 검증 방식 | 테스트·측정·검토의 근거 |
| worktree·branch·base commit | 실제 변경의 위치와 시작점 |
| 외부 자원 | 포트·DB·계정·공유 서비스 충돌 관리 |
| 취소·재사용 조건 | steering 이후 계속 쓸 수 있는 부분 판단 |

함수 하나마다 세션을 만드는 식으로 나누지 않는다. 같은 맥락을 반복 읽는 조각은 묶는다. 반대로 독립적인 모듈을 한 거대한 구현 세션에 몰아 병렬성을 잃지 않는다.

권장 패턴은 먼저 안정적인 인터페이스와 테스트 계약을 좁게 정한 뒤 API·UI·데이터 처리·독립 검증을 병렬 진행하는 것이다. 인터페이스가 불확실하면 그 불확실성을 먼저 실험한다. 임시 인터페이스로 앞서 나가는 경우에는 `provisional`과 예상 재작업 범위를 표시한다.

## 3. 실제 linked worktree의 증거

Native `isolated: true`, branch merge mode, 다른 폴더라는 사실만으로 Git worktree라고 부르지 않는다. 생성 후 다음을 확인한다.

- `git worktree list --porcelain`에 실제 worker 경로가 나타난다.
- worker의 `git rev-parse --show-toplevel`이 배정한 경로와 일치한다.
- `git rev-parse --git-common-dir`로 원본 저장소와의 관계를 확인한다.
- worker별 branch/HEAD와 base commit이 기록돼 있다.
- 각 worker의 실제 cwd와 도구 경로가 해당 worktree를 가리킨다.

Git 명령 실행은 argv 배열 등 안전한 호출 방식으로 처리하고, 사용자 문자열을 shell 코드에 직접 이어 붙이지 않는다. branch·run·work ID는 host가 만든 검증된 식별자를 사용한다.

다음은 설명용 명령이며 경로와 이름은 실행 host가 정한다.

```bash
git worktree add -b wf/run-id/api /absolute/run-worktrees/api BASE_SHA
git worktree add -b wf/run-id/ui /absolute/run-worktrees/ui BASE_SHA
git worktree add --detach /absolute/run-worktrees/integration-check BASE_SHA
```

서로 다른 worktree는 서로 다른 branch를 쓴다. 이미 checkout된 branch를 강제로 중복 연결하지 않는다. `git worktree lock`은 pruning 방지 등에 쓰이는 Git 기능이며, 작업자 사이의 쓰기 mutex를 대신하지 않는다. [S7]

## 4. 기준 상태를 정하는 방법

사용자의 원래 작업 디렉터리에서 미커밋 변경을 강제로 정리하지 않는다. 작업 시작 시 HEAD, staged/unstaged 변경, 필요한 untracked 입력, submodule 상태를 조사한다. 시작점에는 “어느 commit”뿐 아니라 “어떤 기존 변경을 포함했는가”가 있어야 한다.

기존 변경이 이번 기획의 입력이면 사용자 작업 디렉터리를 건드리지 않는 run 소유 snapshot 또는 patch manifest로 재현한다. 기존 변경을 임의로 누락하고 깨끗한 HEAD에서 실행한 뒤 같은 프로젝트를 구현했다고 하지 않는다. 원래 worktree에 무분별하게 commit·stash·reset·clean을 적용하지 않는다.

이 snapshot은 로컬 실행 근거이지 원격 공개 승인이 아니다. 비밀 파일·ignored 파일·대용량 데이터를 자동으로 Git에 추가하지 않는다. 필요한 환경 파일은 기록된 별도 연결이나 안전한 복제로 제공한다. submodule이 있는 경우 실제 checkout·build·capture 지원을 확인하고, 지원되지 않는 다중 checkout을 정상으로 가장하지 않는다. [S7]

run 상태·원문 journal·세션 registry는 코드 branch와 분리한다. Git branch 전환이나 cherry-pick 때문에 의도 기록이 과거로 돌아가면 안 된다.

## 5. 파일 격리만으로 충분하지 않은 자원

| 자원 | 적용할 방법 |
|---|---|
| 소스 파일 | worker별 실제 worktree와 변경 범위 확인 |
| dev server·테스트 포트 | host가 중복 없는 포트 배정, 실제 바인딩 실패 확인 |
| DB·테스트 데이터 | 작업별 DB/schema/namespace 또는 순차 독점 |
| 빌드 출력·임시 파일 | worktree별 디렉터리 또는 동시성 안전한 cache |
| 패키지 설치 | package manager의 지원 범위에 맞춘 cache; 무조건 node_modules 공유 금지 |
| Git refs·worktree 관리 | run별 branch 이름, 관리 동작 직렬화, 조건부 ref 갱신 |
| 외부 계정·배포 | 현재 허용 범위와 해당 효과의 제어 경로 확인 |
| 로컬 모델·빌드 CPU/GPU/RAM | inference와 build/test 슬롯을 별도로 조정 |

`write_set`은 협업용 계약이다. 경로 문자열만으로 악의적인 코드나 임의 shell 접근이 차단되는 보안 경계라고 설명하지 않는다. host 검사로 위반 변경을 탐지하며, 강한 격리가 필요한 작업에는 실제 제어 가능한 실행 환경을 쓴다.

## 6. 동시성은 여러 종류로 관리한다

“동시에 4명” 같은 하나의 수를 모든 자원에 적용하지 않는다. 최소한 원격 모델 추론, 로컬 모델 추론, CPU/RAM을 쓰는 build/test, Git 통합을 구분한다. 원격 모델 응답을 기다리는 세션을 많이 두는 것과 로컬 브라우저·컴파일러를 많이 띄우는 것은 다르다.

기존 provider 제한·사용자 설정·기계의 실제 응답성을 확인한 뒤 준비된 작업을 적극 실행한다. 대기열·오류율·메모리 압박·통합 backlog가 증가하면 해당 자원에만 backpressure를 적용한다. 사용자에게 조용히 비용 절약 모드로 바뀐 것처럼 보이게 하지 말고 원인을 표시한다.

OMP native `task.maxConcurrency`는 SDK/RPC로 따로 실행한 모든 세션의 전역 한도라고 가정하지 않는다. 외부 worktree worker의 동시성은 workflow host가 명시적으로 관리한다. 문서상 기본값이나 unlimited를 하드웨어 권장값으로 복사하지 않는다. [S4, S5]

처리량을 올리는 데 새 로컬 모델이 병목이 될 수 있다. 로컬 System One은 선택 사항이며, steering의 권위·승인·최종 결과 채택을 로컬 classifier의 confidence에 맡기지 않는다.

## 7. 생산적인 병렬 추론과 불필요한 중복을 구분한다

| 유형 | 사용 조건 | 종료 조건 |
|---|---|---|
| 서로 다른 모듈 구현 | 안정된 인터페이스·독립 쓰기 범위 | 각 완료 기준과 통합 검사 충족 |
| 원인 가설 실험 | 다른 가설이 다른 조치를 유발 | 실제 근거로 다음 조치 결정 가능 |
| 대안 구현 비교 | 성능·구조의 중요한 선택이 미해결 | 같은 입력·검사에서 선택 근거 확보 |
| 독립 검토 | 약한 oracle·높은 의미적 영향·명확한 실패 관점 | 해당 불확실성을 판별하는 증거 확보 |
| 같은 결론 반복 확인 | 새로운 관점·근거가 없음 | 시작하지 않거나 중단 |

대안 탐색은 짧은 `decision`을 공유한다: 질문, 비교할 차이, 사용할 원자료, 판별 기준. 후보 수를 상시 고정하지 않는다. 판별이 끝났으면 결과와 근거를 보존하고 필요 없는 후보를 중단한다. 이미 유효한 독립 구현까지 토큰을 줄이려고 멈추지는 않는다.

## 8. 작업자가 반환할 결과

결과는 짧은 채택용 요약과 복구 가능한 근거로 나눈다.

```text
work_id / attempt_id / scope_epoch
source_intent_revision / requirement_versions
base_commit / artifact_commit / changed_paths
completed_criteria / failed_criteria / not_run_criteria
test_commands + exit_status + tested_commit + evidence_refs
interface_changes / dependency_assumptions
unresolved / externally_observed_effects
usage (observed or unknown)
```

“테스트 통과”라는 문장만으로 받지 않는다. 어떤 commit에서 어떤 검사였는지 확인한다. commit 후 추가 수정이 생기면 과거 검사 결과가 새 tree를 검증했다고 표시하지 않는다. 동일 commit에서도 테스트 환경·의존 입력이 바뀌면 해당 검사 유효성을 다시 판단한다.

사용자는 모든 worker의 로그를 읽지 않아도 된다. 상위 세션에는 완료·차단·의도 영향·증거 링크를 전달하며, 정확한 원자료와 diff는 필요할 때 읽을 수 있게 남긴다. 이미 작은 구조화 결과를 별도 모델로 또 요약하지 않는다.

## 9. 단일 writer 통합 절차

worker는 주 브랜치에 직접 합치지 않는다. OMP native isolation을 함께 쓰는 경로에서는 자동 적용을 끄고, 실제 linked worktree worker 역시 같은 통합 경계를 거친다. [S4]

1. **수집:** 결과의 work·attempt·epoch·commit·검사 근거를 등록한다. stale 결과도 삭제하지 않고 보존한다.
2. **현재성 확인:** 적용 요구, 입력/의존 결과, 최신 steering, 권한·pause 상태를 비교한다. 무관한 전체 revision 변경이면 그 호환성 근거를 남긴다.
3. **후보 생성:** 현재 통합 HEAD를 기준으로 작업 결과를 후보 worktree 또는 별도 run 소유 후보 commit에 적용한다. 이 단계의 성공은 최종 채택이 아니다.
4. **실제 검증:** 충돌 처리와 영향을 받는 검사를 수행한다. 텍스트 충돌이 없어도 API·설정·데이터 동작의 결합 오류를 검사한다.
5. **짧은 최종 gate:** 현재 처리한 입력 sequence, 관련 epoch/requirement/input fingerprint, 통합 HEAD, 후보 commit과 검증 대상이 여전히 맞는지 다시 확인한다.
6. **채택:** 단일 writer가 조건부로 통합 기준을 갱신하고 근거를 기록한다. 조건이 달라졌으면 재검증 대상으로 남기며 성공을 발표하지 않는다.

긴 테스트 동안 입력 접수 mutex를 잠그지 않는다. 후보를 검증하는 동안 새 steering을 기록할 수 있어야 한다. 최종 gate 이후 새 사용자 수정이 들어오면 그 시점 이후의 새 변경 작업으로 취급한다. 먼저 들어왔으나 미처리된 수정이 있으면 후보 채택을 보류한다.

canonical accepted ref는 checkout되지 않은 run 소유 ref로 두고 예상 이전 SHA를 조건으로 갱신하는 방식을 권장한다. 검증은 정확한 후보 commit의 별도 작업공간에서 수행한다. checkout된 통합 작업공간을 UI나 검사에 사용하면 host가 소유한 clean 작업공간을 해당 commit에 정렬하고 HEAD·index·파일 상태를 확인한다. ref를 바꾼 것만으로 checkout 파일까지 동기화되었다고 가정하지 않는다. [S15]

Git과 journal은 하나의 원자 transaction이 아니다. `prepare → 실제 ref/commit 확인 → accepted`를 기록하고 장애 시 실물과 기록을 대조한다. run 소유 후보 ref는 만들어졌어도 canonical 채택 기록이 없으면 아직 최종 결과가 아니다. 사용자 원본 branch에 바로 자동 적용하는 경로를 두어 이 gate를 우회하지 않는다.

사용자 작업 디렉터리에 결과를 전달할 때도 예상 HEAD·미커밋 변경·현재 요구를 확인한다. 사용자가 그 사이 바꾼 파일을 덮지 않는다. 충돌하면 현재 결과와 필요한 선택을 구체적으로 보여 준다.

## 10. 스티어링과 병렬 작업의 결합

예를 들어 API·UI·검색 인덱스·회귀검사가 실행 중인데 사용자가 “UI는 좋은데, 검색 결과에 삭제된 문서는 절대 나오면 안 돼”라고 말한다.

- 입력을 기록한 뒤 검색 관련 작업과 검증의 새 실행·통합을 잠시 보류한다.
- 검색 요구와 영향받는 작업의 epoch를 갱신한다.
- API가 검색 응답을 만드는 경우 함께 영향 대상으로 삼는다. 단지 디렉터리가 다르다는 이유로 제외하지 않는다.
- UI의 무관한 작업은 계속한다.
- 기존 검색 결과가 늦게 도착하면 `needs_revalidation`으로 남긴다.
- 새 조건을 포함하는 검사와 정확한 후보 commit을 확보한 뒤 통합한다.

리드는 모든 worker가 끝날 때까지 사용자 답변을 미루지 않는다. 제어 계층이 전달 상태를 보고하고, 모델은 필요할 때 의미적 영향과 변경 기획을 처리한다.

## 11. 재시작과 정리

재시작 때 run journal·승인·대기 입력·worker PID/session·Git branch/worktree·미통합 결과를 대조한다. 연결이 끊겼다고 worker가 멈췄다고 가정하지 않는다. 같은 작업을 중복 시작하지 않고 현재 살아 있는 실행을 식별한다.

사용자가 pause/cancel한 상태를 복원한다. 복구가 끝났더라도 사용자 중단을 자동 해제하지 않는다. 살아 있는 작업을 제어할 수 없으면 상태를 unknown으로 표시하고 결과 채택을 차단한다.

완료 후에는 run이 만든 worktree만, 산출물·commit·필요 로그의 보존을 확인한 뒤 정리한다. dirty worktree를 강제로 삭제하지 않는다. 취소된 후보도 나중에 필요한 근거가 있으면 보관 기한과 위치를 남긴다. 복구와 정리는 완료 시점만이 아니라 중단·크래시·재시도에서도 검증한다.
