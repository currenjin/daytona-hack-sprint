# Collider

각각은 통과하는데 합치면 깨지는 PR을, 합치기 전에 찾습니다.

CI는 이 PR이 오늘의 main과 맞는지만 검사합니다. 곧 머지될 옆 PR과 함께 있어도 괜찮은지는 아무도 검사하지 않습니다.

> Daytona HackSprint Seoul · 2026-09-19

## 문제

```
main
├── PR #1  쿠폰 할인 추가      CI 통과
├── PR #2  멤버십 할인 추가    CI 통과
└── PR #3  부가세 계산 변경    CI 통과

git merge   충돌 없음
기존 테스트  전부 통과          ← GitHub Merge Queue 도 여기서 통과시킵니다

쿠폰과 멤버십을 동시에 쓰는 주문 하나
  명세상 8,000원
  실제   8,100원
```

PR #1 작성자는 멤버십을 몰랐고, #2 작성자는 쿠폰을 몰랐습니다. 그래서 두 기능을 함께 쓰는 테스트가 레포에 없습니다.

GitHub Merge Queue는 레포에 있는 테스트를 돌립니다. 없는 테스트를 만들지는 않습니다.

## 쓰는 방식 두 가지

```
Public Web   PR URL 을 직접 넣어 검사
GitHub CI    PR 이 열리거나 바뀌면 자동 검사 → GitHub Check → PR Comment
```

## 동작

```
PR N 개
   │
[1] 조합 선정                                   모든 쌍 + 전체 한 묶음
   │
[2] diff 와 명세 문서 수집                      gh CLI
   │
[3] Daytona 샌드박스에서 실제로 머지
   │
[4] 기존 테스트 실행 → 통과 확인                 Merge Queue 통과 지점을 먼저 보여줍니다
   │
[5] Nosana GPU 의 qwen3.5:9b 가 겹치는 지점을 추정하고
   │   상호작용 테스트를 작성 (기대값 근거는 명세 문서)
   │
[6] 샌드박스에서 생성 테스트 실행 → 실패          충돌 증명
```

qwen3.5:9b가 가설을 세우고, Daytona 샌드박스가 실행으로 증명합니다. 추측으로 끝내지 않습니다.

조합마다 샌드박스를 새로 띄우지는 않습니다. Collider 는 샌드박스 하나를 유지하면서 `git reset --hard` 로 base 로 되돌린 뒤 다음 조합을 머지합니다.

## PR 이 20개면

열린 PR 이 20개면 크기 2 이상인 부분집합은 1,048,555 가지입니다. Collider 는 그중 191 가지만 검사합니다. 모든 쌍 190 가지에 전체 한 묶음을 더한 수입니다.

| 열린 PR | 2^N 중 크기 2 이상 | Collider 가 보는 조합 |
|---|---|---|
| 3 | 4 | 4 |
| 5 | 26 | 11 |
| 10 | 1,013 | 46 |
| 20 | 1,048,555 | 191 |

이유는 두 가지입니다. 실제로 어긋나는 자리는 기능 둘이 만나는 지점과 전부 합친 지점에 몰려 있습니다. 그리고 조합 하나마다 Nosana 추론이 한 번씩 들어가므로, **조합 수를 줄이면 크레딧 소모가 같은 비율로 줄어듭니다.**

기존 테스트가 이미 실패하는 조합은 거기서 멈춥니다. 상호작용 테스트를 만들지 않으므로 Nosana 호출 한 번을 아낍니다. 선정 로직은 `lib/combos.ts` 에 있습니다.

## 핵심 연동

| | 역할 | 코드 |
|---|---|---|
| Daytona | 미래 머지 상태를 격리 실행, 조합마다 테스트 2회 실행 | `lib/collide.ts` |
| Nosana | 충돌 가설과 상호작용 테스트 생성 (qwen3.5:9b) | `lib/interaction.ts`, `lib/generate.ts` |

## 로컬 실행

```bash
npm install
cp .env.example .env    # DAYTONA_API_KEY, LLM_ENDPOINT / LLM_MODEL, GITHUB_TOKEN
npm run preflight       # 스폰서 자격증명 일괄 검증
npm run dev             # http://localhost:5173
```

데모 레포는 [currenjin/collider-demo](https://github.com/currenjin/collider-demo) 입니다. PR #1 쿠폰, #2 멤버십, #3 부가세가 열려 있고 #1 과 #2 가 충돌합니다.

```
owner/repo#1  →  currenjin/collider-demo#1
owner/repo#2  →  currenjin/collider-demo#2
owner/repo#3  →  currenjin/collider-demo#3
```

## GitHub CI 로 쓰기

PR 이 열리거나 갱신되면 Collider 가 그 PR 을 같은 레포의 다른 열린 PR 과 하나씩 맞춰 봅니다. 결과는 GitHub Check 와 PR 코멘트로 돌아옵니다.

### 1. GitHub secrets 등록

Settings → Secrets and variables → Actions 에 다음 다섯 개를 넣으세요.

| 이름 | 설명 |
|---|---|
| `DAYTONA_API_KEY` | Daytona API 키 |
| `DAYTONA_API_URL` | Daytona API 주소 |
| `NOSANA_API_KEY` | Nosana 크레딧 잔액 조회용 |
| `LLM_ENDPOINT` | Nosana 배포의 OpenAI 호환 주소 |
| `LLM_MODEL` | 모델 이름 |

`GITHUB_TOKEN` 은 따로 등록하지 마세요. Actions 가 자동으로 넣어 줍니다.

### 2. workflow 복사

Collider 소스가 다른 레포에 있어서 checkout 이 두 번입니다. 아래를 `.github/workflows/collider.yml` 로 저장하세요.

```yaml
name: Collider
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  collider:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          repository: currenjin/daytona-hack-sprint
          path: collider
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
        working-directory: collider
      - run: npm run collider -- --repo ${{ github.repository }} --pr ${{ github.event.pull_request.number }}
        working-directory: collider
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DAYTONA_API_KEY: ${{ secrets.DAYTONA_API_KEY }}
          DAYTONA_API_URL: ${{ secrets.DAYTONA_API_URL }}
          NOSANA_API_KEY: ${{ secrets.NOSANA_API_KEY }}
          LLM_ENDPOINT: ${{ secrets.LLM_ENDPOINT }}
          LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### 3. PR 열기

같은 CLI 를 로컬에서도 부를 수 있습니다.

```bash
npm run collider -- --repo currenjin/collider-demo --pr 1
```

`--pr` 로 준 번호를 기준 PR 로 삼아 같은 레포의 다른 열린 PR 을 찾고 조합을 만듭니다. `PUBLIC_BASE_URL` 을 넣어 두면 PR 코멘트에 리포트 주소가 함께 붙습니다.

## CI · Merge Queue · Collider

| | 검사 대상 | 쓰는 테스트 |
|---|---|---|
| CI | PR 하나와 현재 main | 레포에 있는 테스트 |
| GitHub Merge Queue | 큐에 든 PR 묶음 | 레포에 있는 테스트 |
| Collider | 아직 열려 있는 PR 조합 | 없으면 만듭니다 |

## 실측

`currenjin/collider-demo` 의 PR #1 × #2 기준입니다.

```
샌드박스 부팅 1.2s · 클론 0.9s · 설치와 테스트 2.4s
조합 하나 35.5s (생성 25s 포함)

git 충돌 없음
기존 테스트 4/4 통과
생성 테스트 45줄, import 경로 1건 자동 교정
실행 결과 실패, 기대 8,000 / 실제 8,100
```

두 번째 조합부터는 부팅과 클론과 설치 시간이 빠집니다. 샌드박스 하나를 계속 재사용하기 때문입니다.
