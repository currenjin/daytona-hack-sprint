# Collider

각각은 통과하는데 합치면 깨지는 PR을, 합치기 전에 찾습니다.

CI는 이 PR이 오늘의 main과 맞는지만 검사합니다. 곧 머지될 옆 PR과 함께 있어도 괜찮은지는 아무도 검사하지 않습니다.

> Daytona HackSprint Seoul · 2026-09-19

## 문제

```
main
├── PR #1  쿠폰 할인 추가      CI 통과
└── PR #2  멤버십 할인 추가    CI 통과

git merge   충돌 없음
기존 테스트  전부 통과          ← GitHub Merge Queue 도 여기서 통과시킵니다

쿠폰과 멤버십을 동시에 쓰는 주문 하나
  명세상 8,000원
  실제   8,100원
```

PR #1 작성자는 멤버십을 몰랐고, #2 작성자는 쿠폰을 몰랐습니다. 그래서 두 기능을 함께 쓰는 테스트가 레포에 없습니다.

GitHub Merge Queue는 레포에 있는 테스트를 돌립니다. 없는 테스트를 만들지는 않습니다.

## 동작

```
PR 두 개
   │
[1] diff 와 명세 문서 수집                     gh CLI
   │
[2] Daytona 샌드박스에서 실제로 머지
   │
[3] 기존 테스트 실행 → 통과 확인                Merge Queue 통과 지점을 먼저 보여줍니다
   │
[4] Nosana GPU 의 qwen3.5:9b 가 겹치는 지점을 추정하고
   │   상호작용 테스트를 작성 (기대값 근거는 명세 문서)
   │
[5] 샌드박스에서 생성 테스트 실행 → 실패         충돌 증명
   │
DNSimple 로 리포트 주소 발급
```

qwen3.5:9b가 가설을 세우고, Daytona 샌드박스가 실행으로 증명합니다. 추측으로 끝내지 않습니다.

## 스폰서 통합

| | 역할 | 코드 |
|---|---|---|
| Daytona | 미래 머지 상태를 격리 실행, 테스트 2회 실행 | `lib/collide.ts` |
| Nosana | 충돌 가설과 상호작용 테스트 생성 (qwen3.5:9b) | `lib/interaction.ts`, `lib/generate.ts` |
| DNSimple | 충돌 리포트 주소 발급 | `lib/dns.ts` |

## 실행

```bash
npm install
cp .env.example .env    # DAYTONA_API_KEY, LLM_ENDPOINT/LLM_MODEL, DNSIMPLE_*
npm run preflight       # 스폰서 자격증명 일괄 검증
npm run dev             # http://localhost:5173
```

데모 레포는 [currenjin/collider-demo](https://github.com/currenjin/collider-demo)이고 PR #1, #2가 열려 있습니다.

```
owner/repo#1  →  currenjin/collider-demo#1
owner/repo#2  →  currenjin/collider-demo#2
```

## 기존 도구와의 차이

| | 검사 대상 | 쓰는 테스트 |
|---|---|---|
| CI | PR 하나와 현재 main | 레포에 있는 것 |
| GitHub Merge Queue | 큐에 든 PR 묶음 | 레포에 있는 것 |
| Collider | 아직 열려 있는 PR 조합 | 없으면 만듭니다 |

## 실측

`currenjin/collider-demo#1 × #2` 기준입니다.

```
샌드박스 부팅 1.2s · 클론 0.9s · 설치와 테스트 2.4s
전체 35.5s (생성 25s 포함)

git 충돌 없음
기존 테스트 4/4 통과
생성 테스트 45줄, import 경로 1건 자동 교정
실행 결과 실패, 기대 8,000 / 실제 8,100
```
