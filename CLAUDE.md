# Ship — 프로젝트 컨텍스트

## 무엇을 만드는가
AI가 만든 앱을 **격리된 샌드박스에서 실행하고, 스스로 검증하고, 깨졌으면 고친 다음**,
진짜 도메인으로 출시한다. 검증 루프가 이 프로젝트의 핵심이다 — 그게 없으면 LLM wrapper다.

```
프롬프트 → 생성(Nosana) → 실행(Daytona) → 검증 → [실패 시 수정→재배포→재검증] → 출시(DNSimple)
```

## 절대 제약
- **해커톤 2시간짜리다.** 동작하는 데모 > 좋은 코드. 항상.
- 추상화 금지. 인터페이스/베이스클래스/DI 금지. 함수 하나로 될 일은 함수 하나로.
- 단위 테스트 프레임워크 금지. `scripts/e2e-offline.ts` 와 `scripts/test-*.ts` 로 **실제로 실행해서 눈으로 확인**한다.
- 의존성 추가는 최소. 새로 깔기 전에 Node 내장으로 되는지 먼저 생각할 것.
- 에러는 사용자에게 **한국어 한 줄**. 스택트레이스는 터미널에만 (`friendly()` in server.ts).
- 모든 작업은 **검증 명령을 실행해서 통과시킨 뒤** 끝난 것으로 본다. 코드만 쓰고 끝내지 말 것.

## 파일 지도
| 파일 | 역할 |
|---|---|
| `server.ts` | SSE 오케스트레이션 + 수정 루프 (`MAX_REPAIRS`) |
| `lib/generate.ts` | 생성/수정. OpenAI 호환(Nosana/Ollama) 또는 Anthropic |
| `lib/sandbox.ts` | Daytona 부팅 · 파일 배포 · 정적 서버 · preview URL |
| `lib/verify.ts` | 샌드박스 안에서 도는 검증기 (`VERIFY_JS`) |
| `lib/dns.ts` | 라우터 등록 · DNSimple 레코드 · 전파 대기 · 폴백 |
| `router/index.js` | VPS용 무의존성 리버스 프록시 (Host → slug → preview) |

## 검증된 API (추측 금지, 이대로 쓸 것)

**Daytona TS SDK** — 패키지는 `@daytona/sdk` (구 `@daytonaio/sdk` 는 deprecated)
```ts
const sandbox = await new Daytona().create({ language:'typescript', public:true, autoStopInterval:60 }, { timeout:180 })
await sandbox.process.executeCommand('...')   // → { exitCode, result }
const link = await sandbox.getPreviewLink(3000)  // → { url, token }
```

**DNSimple**
```
POST https://api.dnsimple.com/v2/{account}/zones/{zone}/records
Authorization: Bearer {token} / Accept: application/json / Content-Type: application/json
{ "name":"<slug>.ship", "type":"A", "content":"<ip>", "ttl":60 }
```

**생성 엔진** — OpenAI 호환 `POST {LLM_ENDPOINT}/chat/completions`, `stream: true`

## 알려진 함정
- Node `fetch`(undici)는 **Host 헤더를 조용히 버린다**. 라우터 테스트는 `node:http` 를 써야 한다.
- `execFileSync` 는 이벤트 루프를 막는다. 같은 프로세스의 로컬 서버를 찌르는 테스트에서는 비동기로.
- 정적 서버가 디스크를 매번 읽으므로 **파일만 덮어쓰면 재배포 끝** (재시작 불필요).

## 심사 기준 (모든 판단의 기준선)
1. MVP 완성도 — **미완성은 0점. 범위를 줄여서라도 끝낸다**
2. 혁신성 — "에이전트가 자기 결과물을 검증하고 책임지고 출시한다"
3. 실제 문제 해결 — 검증 없이 배포되는 AI 생성 코드
4. **스폰서 통합 — Daytona / DNSimple / Nosana 셋 다 실제로 호출되어야 한다**

## 시간 예산
14:00 생성+샌드박스 / 14:45 검증 루프 / 15:10 DNS+QR / 15:30 통합 / 15:45 리허설 / **16:00 데모**
15:45에는 무조건 코딩을 멈춘다.
