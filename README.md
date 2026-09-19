# Collider

**각각은 초록인데, 합치면 깨집니다.**

CI는 이 PR이 **오늘의 main**과 맞는지만 검사합니다.
곧 머지될 **다른 PR과 함께 있어도 괜찮은지**는 아무도 검사하지 않습니다.

> Daytona HackSprint Seoul · 2026-09-19

## 문제

```
main
├── PR #1  쿠폰 할인 추가      CI ✓
└── PR #2  멤버십 할인 추가    CI ✓

git merge  →  충돌 없음
기존 테스트 →  전부 통과        ← GitHub Merge Queue 도 여기서 통과시킵니다

그런데 쿠폰과 멤버십을 동시에 쓰면
명세상 8,000원이어야 할 청구액이 8,100원이 됩니다.
```

**왜 아무도 못 잡나:** 이 상호작용을 커버하는 테스트가 레포에 없기 때문입니다.
PR #1 작성자는 멤버십을 몰랐고, PR #2 작성자는 쿠폰을 몰랐습니다.

Merge Queue는 **있는 테스트**를 돌립니다. **없는 테스트는 못 만듭니다.**

## 동작

```
PR 두 개
   │
[1] diff + 명세 문서 수집                      gh CLI
   │
[2] Daytona 샌드박스에서 실제로 머지            ← 격리 필수
   │
[3] 기존 테스트 실행 → 초록 확인                ← Merge Queue 통과 지점을 먼저 보여준다
   │
[4] Nosana GPU: 겹치는 지점 가설 → 상호작용 테스트 생성
   │            (명세 문서가 기대값의 근거)
   │
[5] 샌드박스에서 생성 테스트 실행 → 빨강        ← 충돌 증명
   │
DNSimple 로 리포트 주소 발급
```

**AI가 가설을 세우고, Daytona가 증명합니다.** 가설만으로 끝내지 않습니다.

## 스폰서 통합

| | 역할 | 코드 |
|---|---|---|
| **Daytona** | 미래 머지 상태를 격리 실행 · 테스트 2회 실행 | `lib/collide.ts` |
| **Nosana** | 충돌 가설 + 상호작용 테스트 생성 | `lib/interaction.ts`, `lib/generate.ts` |
| **DNSimple** | 충돌 리포트 주소 발급 | `lib/dns.ts` |

## 실행

```bash
npm install
cp .env.example .env    # DAYTONA_API_KEY, LLM_ENDPOINT/LLM_MODEL, DNSIMPLE_*
npm run dev             # http://localhost:5173
```

데모 레포: **[currenjin/collider-demo](https://github.com/currenjin/collider-demo)** — PR #1, #2

```
owner/repo#1  →  currenjin/collider-demo#1
owner/repo#2  →  currenjin/collider-demo#2
```

## 기존 도구와의 차이

| | 검사 대상 | 테스트 |
|---|---|---|
| CI | PR ↔ 현재 main | 있는 것 |
| GitHub Merge Queue | 큐에 든 PR 묶음 | **있는 것** |
| **Collider** | **아직 열려 있는 PR 조합** | **없으면 만든다** |
