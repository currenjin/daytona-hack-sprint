# Ship

**AI가 만든 앱을, 스스로 검증해서, 진짜 도메인에 출시합니다.**

> Production shouldn't be the first place your app fails.

AI가 만든 앱은 검증 없이 localhost에서 죽습니다. Ship은 생성된 앱을 격리된 샌드박스에서
**실제로 실행하고, 스스로 검증하고, 깨졌으면 고친 다음**, 실제 DNS 주소로 출시합니다.

> Daytona HackSprint Seoul · 그라운드옥탑, 강남

## 동작

```
"홍대 라멘집 리뷰 사이트"
      │
 [1] 생성        Nosana GPU 오픈모델 → 단일 HTML
      │
 [2] 격리 실행    Daytona 샌드박스에서 실제로 띄움
      │
 [3] 자기 검증    인라인 스크립트 문법 · 서버 200 · 문서 구조
      │          jsdom으로 스크립트 실행 + 클릭까지 실제로 눌러봄
      │
      ├─ 실패 → 문제를 모델에 되먹여 수정 → 재배포 → 재검증
      │
 [4] 출시        DNSimple로 실제 DNS 레코드 생성 + 와일드카드 TLS
      │
https://hongdae-ramen-847.ship.<도메인>  +  QR
```

## 스폰서 통합 — 3/3

| | 역할 | 코드 |
|---|---|---|
| **Daytona** | 격리 실행 + 검증 무대 + 재배포 | `lib/sandbox.ts`, `lib/verify.ts` |
| **Nosana** | 앱 생성 엔진 (GPU 오픈모델) | `lib/generate.ts` |
| **DNSimple** | 실제 DNS 레코드 + 와일드카드 TLS | `lib/dns.ts`, `Caddyfile` |

셋 중 하나라도 빠지면 작동하지 않습니다. 장식이 없습니다.

## 실행

```bash
npm install
cp .env.example .env    # 채우기
npm run preflight       # 스폰서 자격증명 + 검증기까지 일괄 확인
npm run dev             # http://localhost:5173
```

VPS 쪽(실제 도메인을 쓰려면 필요):

```bash
# Caddy: 와일드카드 TLS 종료 → localhost:8080 프록시 (Caddyfile 참고)
ROUTER_SECRET=... node router/index.js
```

### 생성 엔진 고르기

OpenAI 호환 `/chat/completions` 를 주는 곳이면 무엇이든 됩니다.

```bash
# Nosana — vLLM/Ollama 컨테이너를 GPU에 배포하고 노출된 URL 사용
LLM_ENDPOINT=https://<배포-주소>/v1
LLM_MODEL=<모델명>

# 로컬 — 크레딧 없이 공짜로 테스트할 때
LLM_ENDPOINT=http://localhost:11434/v1
LLM_MODEL=qwen2.5-coder:7b
```

`ANTHROPIC_API_KEY` 만 있어도 동작합니다(`claude-opus-5`). `LLM_ENDPOINT` 가 우선입니다.

DNSimple 설정이 비어 있으면 Daytona preview URL로 자동 폴백하므로, **도메인 없이도 전 구간이 돌아갑니다.**

## 테스트

```bash
npm run e2e            # 키 없이 도는 구간 전체 (24개 검사)
npm run typecheck
npm run test:generate -- "홍대 라멘집 리뷰 사이트"
npm run test:sandbox
npm run test:publish -- https://example.com
```

`npm run e2e` 는 실제 모듈을 연결해 슬러그·라우터 등록·프록시 체인·폴백·QR·SSE 계약과
**검증기 자체**(깨진 앱을 잡아내는지 / 정상 앱을 통과시키는지)까지 확인합니다.

## 문서

- [`PREP.md`](PREP.md) — 행사 전날 세팅 체크리스트 (여기가 제일 중요)
- [`PROMPTS.md`](PROMPTS.md) — 당일 2시간 타임라인 + 데모 대본
- [`CLAUDE.md`](CLAUDE.md) — 에이전트용 프로젝트 제약
- [`Caddyfile`](Caddyfile) — 와일드카드 TLS 설정
