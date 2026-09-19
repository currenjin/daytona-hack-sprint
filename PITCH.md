# Collider — Final 3-minute Pitch

> 발표 언어: 한국어  
> 목표: 문제 → 실제 실행 → 충돌 증거 → CI 적용까지 3분 안에 보여준다.

---

## 0:00–0:20 — Pull Request

> "먼저 개발자가 아닌 분들을 위해 Pull Request, PR부터 짧게 설명드리겠습니다."
>
> "개발자가 코드를 수정했다고 바로 서비스에 반영하지는 않습니다. 먼저 PR을 올리고, 리뷰와 자동 검사를 통과한 뒤 main 코드에 합칩니다."
>
> "문제는 PR 하나가 아니라, 여러 PR이 결국 같은 main에서 함께 동작한다는 점입니다."

---

## 0:20–0:42 — Problem

화면: PR #1, #2, #3 각각 PASS.

> "요즘 Claude Code나 Codex 같은 코딩 에이전트 덕분에 여러 작업이 동시에 훨씬 빠르게 진행됩니다."
>
> "그런데 검증은 여전히 PR 하나씩 이뤄지는 경우가 많습니다."
>
> "여기 있는 쿠폰, 멤버십, 부가세 PR도 하나씩 보면 전부 정상입니다."
>
> "하지만 각각 정상이라고 해서, 같이 있을 때도 정상이라는 뜻은 아닙니다."

---

## 0:42–0:58 — Collider

화면: Collider 첫 화면. Demo preset 입력 후 실행.

> "Collider는 이 PR들을 실제로 합치기 전에, 함께 있는 미래의 main을 먼저 만들어봅니다."
>
> "지금 이 세 PR을 넣고 미래 충돌 검사를 실행해보겠습니다."

---

## 0:58–1:28 — Daytona: future main 실행

화면: 검사 진행 / 기존 테스트 통과.

> "Collider는 Daytona 샌드박스에 저장소를 clone하고, PR 조합을 실제로 merge합니다."
>
> "즉 아직 main에는 존재하지 않는 코드 상태를 격리된 환경에서 먼저 실행합니다."
>
> "그리고 기존 테스트부터 돌립니다."
>
> "여기서는 git 충돌도 없고, 기존 테스트도 모두 통과합니다."
>
> "기존 CI만 보면 이 변경은 정상입니다."

---

## 1:28–1:55 — Nosana: 빠진 interaction test 생성

화면: #1 + #2 상세 / 생성 테스트.

> "하지만 기존 테스트에는 쿠폰과 멤버십을 같이 쓰는 경우가 없습니다."
>
> "Nosana에서 실행되는 qwen3.5:9b가 PR diff와 프로젝트 명세를 읽고, 두 변경이 만나는 지점을 찾습니다."
>
> "그리고 저장소에 없던 interaction test를 만듭니다."
>
> "중요한 건 AI의 설명만 믿지 않는다는 점입니다. 생성된 테스트도 다시 Daytona에서 실제로 실행합니다."

---

## 1:55–2:18 — Collision

화면: #1 + #2 COLLISION.

```
Git merge          PASS
Existing tests     PASS
Interaction test   FAIL

Expected           8,000
Actual             8,100
```

> "결과가 나왔습니다."
>
> "쿠폰만 쓰면 정상이고, 멤버십만 써도 정상입니다."
>
> "하지만 둘을 같이 쓰면 명세상 8,000원이어야 하는 금액이 8,100원이 됩니다."
>
> "각 PR도 통과했고, 합친 뒤 기존 테스트도 통과했지만, 두 기능을 함께 쓰는 순간 처음 문제가 드러났습니다."

---

## 2:18–2:33 — Collision Matrix

화면: Future Collision Matrix.

> "PR이 여러 개면 조합별 결과를 Matrix로 보여줍니다."
>
> "#1과 #2는 충돌하지만, #1과 #3, #2와 #3은 정상입니다."
>
> "그래서 팀은 어떤 PR 조합을 먼저 확인해야 하는지 바로 알 수 있습니다."

---

## 2:33–2:50 — 실제 팀 사용: GitHub CI

화면: 실제 GitHub Actions + PR comment SVG.

> "웹에서는 PR URL을 직접 넣어 검사할 수 있습니다."
>
> "팀에서는 같은 엔진이 GitHub Actions에서 자동으로 실행됩니다."
>
> "PR이 열리거나 변경되면 다른 open PR들과 검사하고, 충돌이 있으면 바로 해당 PR에 결과와 증거를 남깁니다."

가능하면 실제 failure comment를 보여준다.

> "즉 별도 대시보드에 들어가지 않아도 기존 개발 흐름 안에서 바로 확인할 수 있습니다."

---

## 2:50–3:00 — Closing

> "코드를 만드는 속도는 계속 빨라지고 있습니다."
>
> "Collider는 PR 하나를 더 잘 리뷰하는 도구가 아니라, 서로 다른 변경 사이에서 생기는 문제를 찾는 도구입니다."
>
> "**합치면 깨지는 PR을, 합치기 전에 찾습니다. Collider였습니다.**"

---

# 발표 중 반드시 보여줄 장면

1. PR #1 / #2 / #3이 각각 정상인 상태
2. Collider에서 세 PR 실행
3. Daytona에서 merge + existing tests PASS
4. Nosana가 만든 interaction test
5. #1 + #2의 Expected 8,000 / Actual 8,100
6. Collision Matrix
7. 실제 GitHub Actions / PR comment

---

# Q&A

## "GitHub Merge Queue와 뭐가 다른가요?"

> "Merge Queue는 여러 변경을 합쳐볼 수 있지만 기본적으로 저장소에 이미 있는 테스트를 실행합니다. Collider는 PR 사이에 필요한 테스트가 없으면 interaction test를 새로 만든 뒤 그 테스트까지 실제로 실행합니다."

## "CodeRabbit 같은 AI 코드 리뷰와 뭐가 다른가요?"

> "코드 리뷰는 주로 한 PR의 변경을 분석합니다. Collider는 서로 다른 PR을 실제로 함께 merge하고 실행해서, 변경 사이에서만 나타나는 동작 문제를 찾습니다."

## "AI가 잘못된 테스트를 만들면요?"

> "모델 출력 자체를 collision으로 보지 않습니다. 기대 동작의 근거가 명세에서 확인되지 않거나 검증할 수 없으면 collision이 아니라 check error로 처리합니다. 실제 collision은 검증된 기대 동작과 Daytona에서 실행한 실제 결과가 다를 때만 표시합니다."

## "왜 Daytona가 꼭 필요한가요?"

> "Collider가 검사하는 건 아직 존재하지 않는 미래의 main입니다. 여러 PR을 실제로 merge하고 dependency 설치와 테스트까지 실행해야 하므로, 현재 개발 환경과 분리된 실행 환경이 필요합니다. 그 환경을 Daytona로 만듭니다."

## "왜 Nosana인가요?"

> "PR diff와 명세에서 빠진 interaction을 찾고 테스트 시나리오를 생성하는 모델을 Nosana에서 실행합니다. 생성 결과는 Daytona에서 다시 검증합니다."

## "PR이 많으면 조합 수가 너무 커지지 않나요?"

> "현재는 모든 pair와 전체 조합을 검사합니다. 모든 부분집합을 보는 것보다 훨씬 작고, 실제 제품에서는 변경 파일이나 의존 관계를 기준으로 우선 검사할 조합을 더 줄일 수 있습니다."

## "실제 팀에서는 어떻게 사용하나요?"

> "Web에서는 PR URL을 직접 넣어 확인하고, 팀에서는 GitHub Actions에 연결합니다. PR이 열리거나 업데이트될 때 자동 실행되고 결과는 PR check와 comment로 돌아옵니다."

---

# 발표 직전 체크

- [ ] #1 + #2 → COLLISION
- [ ] Expected 8000 / Actual 8100
- [ ] #1 + #3 → SAFE
- [ ] #2 + #3 → SAFE
- [ ] Web과 CI 결과 동일
- [ ] GitHub Actions 최신 run 확인
- [ ] Failure PR comment 이미지 확인
- [ ] Issue #1 링크 열리는지 확인
- [ ] 라이브 실패 시 보여줄 캡처 준비
