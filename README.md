# Ship

**한 줄 프롬프트 → 90초 뒤, 진짜 도메인에서 살아있는 웹앱.**

AI가 만든 앱은 전부 localhost나 임시 preview URL에서 죽습니다.
실제 주소와 TLS를 붙이는 마지막 1마일이 항상 사람 몫이었습니다. Ship은 그 1마일을 지웁니다.

> Daytona HackSprint Seoul · 그라운드옥탑, 강남

## 아키텍처

```
브라우저 ── POST /api/ship (SSE) ──> server.ts
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
            lib/generate.ts     lib/sandbox.ts        lib/dns.ts
          Claude Opus 5로       Daytona 샌드박스        DNSimple 레코드
          단일 HTML 생성      실행 + preview URL       + 라우터 등록
                    │                 │                  │
                    └── lib/nosana.ts (오픈모델 검수) ────┘
                                      │
              https://<slug>.ship.<zone>
                        │
              VPS: Caddy (와일드카드 TLS) → router/index.js → Daytona preview
```

## 스폰서 통합

| 스폰서 | 역할 |
|---|---|
| **Daytona** | 생성된 앱을 격리 샌드박스에서 실행하고 공개 preview URL을 노출 (`lib/sandbox.ts`) |
| **DNSimple** | 배포마다 실제 DNS A 레코드를 API로 생성하고 와일드카드 TLS를 발급 (`lib/dns.ts`, `Caddyfile`) |
| **Nosana** | 분산 GPU의 오픈모델이 생성된 앱을 검수 (`lib/nosana.ts`) |

## 실행

```bash
npm install
cp .env.example .env    # 채우기
npm run preflight       # 스폰서 4곳 자격증명 일괄 검증
npm run dev             # http://localhost:5173
```

VPS 쪽(선택, 실제 도메인을 쓰려면 필요):

```bash
# Caddy: 와일드카드 TLS 종료 → localhost:8080 프록시 (Caddyfile 참고)
ROUTER_SECRET=... node router/index.js
```

`.env`에 DNSimple/라우터 설정이 없으면 Daytona preview URL로 자동 폴백하므로,
도메인 없이도 전체 플로우가 돌아갑니다.

## 개별 검증

```bash
npm run test:generate -- "홍대 라멘집 리뷰 사이트"   # HTML 생성만
npm run test:sandbox                                # 샌드박스 + preview URL
npm run test:publish -- https://example.com         # 라우터 + DNS + 실제 접속
npm run typecheck
```

## 문서

- [`PREP.md`](PREP.md) — 행사 전날 세팅 체크리스트 (여기가 제일 중요)
- [`PROMPTS.md`](PROMPTS.md) — 당일 2시간 타임라인 + 데모 대본
- [`CLAUDE.md`](CLAUDE.md) — 에이전트용 프로젝트 제약
- [`Caddyfile`](Caddyfile) — 와일드카드 TLS 설정
