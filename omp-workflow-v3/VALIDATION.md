# 이 전달물에서 수행한 검증

검증일: 2026-11-10 (Asia/Seoul).

## 1. 작성·검토한 것

v2를 사용자의 최신 선호로 갱신했다. 초기 대화형 기획·명시적 확정, 실행 중 자연어 steering, 원문·승인·전달/확인·작업별 최신성, 실제 linked worktree 병렬 구현, 단일 writer 통합, 과추론에 한정한 억제 정책, OMP와 pi 선택을 구체화했다.

공식 OMP·pi·Git 문서를 조사하고 다음 오류 가능성을 별도로 검토했다.

- native isolation을 실제 Git linked worktree로 잘못 표시하는 경우.
- focused-child 입력이 main hook을 지나지 않아 변경 원문이 누락되는 경우.
- plan review preview와 실제 승인 내용이 달라지는 경우.
- 접수·전달·확인·결과 반영을 혼동하는 경우.
- sequence 최댓값으로 이전 관련 변경 누락을 숨기는 경우.
- 검증 중 입력 변경·통합 HEAD 변경·후보 commit 변경·중복 채택.
- canonical ref만 갱신하고 checkout된 index/파일이 동기화됐다고 가정하는 경우.

## 2. 실행한 참조 모델 검사: 30개 통과

위치: `reference/control_model.py`, `reference/test_control_model.py`.

```bash
python3 -m unittest discover -s reference -v
```

위 명령은 `omp-workflow-v3` 디렉터리에서 실행한다. 최종 확인 결과:

```text
Ran 30 tests in 0.004s
OK
```

검사 범위는 현재 기획 승인, 미분류 입력 보류, scope별 변경, 오래된 attempt/ack/result, 최신 전달 확인, pause/cancel, 중복 source ID, 복구 전 차단, 최종 채택 시 상태/HEAD/검증 연결, 관련 event 누락, 중복 채택이다. 실행 검증 근거와 원문 검토 근거를 구분하며, 근거 참조가 있다는 사실만으로 내용의 진실을 증명하지 않는다.

**순수 메모리 참조 모델**이다. 자연어 의미와 영향 범위는 fixture가 명시적으로 제공한다. 실제 저장·worker 인증·Git·OMP·provider·도구 중단·전달 지연·원문 의미 보존을 검증하지 않는다. commit·증거는 가상 문자열이며 reference 자체를 production controller로 설치하라는 뜻이 아니다.

모델은 최종 채택 전 control snapshot 변화에 보수적으로 반응한다. 실제 구현은 상태 질문 같은 무관한 입력을 재확인한 뒤 기존 artifact 검사 근거를 재사용할 수 있다. 새 receipt가 필요하다는 이유로 모든 검사를 반복할 필요는 없다.

## 3. Fixture의 구조 검사

```bash
python3 eval/validate_fixtures.py
```

결과:

```json
{
  "source_spans_checked": {"intent_trace": 8, "steering_trace": 7},
  "manual_cases": 32,
  "hypothetical_steering_events": 13,
  "record_references_and_event_order": "structurally_valid",
  "normal_intent_example": "structurally_valid",
  "semantically_narrowed_example": "also_structurally_valid",
  "conclusion": "Source pointers and record validation alone do not prove intent fidelity.",
  "natural_language_interpretation": "not_evaluated",
  "manual_acceptance_execution": "not_run",
  "live_omp_git_or_model_evaluation": "not_run"
}
```

32개는 실제 인수 검사를 통과한 개수가 아니라 **수동 검증 시나리오의 수**다. 예제는 가상 자료이며 실제 사용자의 추가 승인이나 실행 결과가 아니다.

“기존 API를 보존”이라는 해석을 “함수 이름을 보존”으로 축소해도 source pointer와 구조 검사가 통과한다는 반례를 유지했다. 실제 의미 검증이 따로 필요한 이유다.

## 4. 전달물 확인

Markdown code fence, 파일 구성, JSON/JSONL 구조와 참조를 확인했다. ZIP에는 문서·프롬프트·fixture·참조 코드만 포함하며 Python cache 파일은 제외한다. 합본에는 같은 전달 내용을 모두 포함한다.

## 5. 실행하지 않은 검증

- 사용자 로컬 OMP 설치·설정 변경과 실제 SDK/RPC 실행.
- 실제 Git worktree의 동시 수정·통합·장애 복구.
- live model의 한국어 기획 해석·steering 영향 판정.
- provider별 중단 동작, 사용자 입력의 실제 반영 지연.
- 사용자 하드웨어에서의 동시성·완료 시간·토큰·비용 측정.
- AgentFabric 또는 pi adapter의 구현과 채택.

따라서 이 자료는 **검토한 설계와 구현 지시, 검증 가능한 인수 조건**이다. 실제 환경의 구축 완료나 속도 향상률을 보고한 문서가 아니다. 실제 설치 때는 IMPLEMENTATION_AND_EVAL의 작은 end-to-end 경로를 먼저 완성하고 관찰 결과를 남긴다.
