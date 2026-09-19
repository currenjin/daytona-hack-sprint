# Ship — 프로젝트 컨텍스트

> 당일 프로젝트 레포 루트에 이 파일을 복사해 두세요. 에이전트가 매 프롬프트마다
> 제약을 다시 설명하지 않아도 되고, 과잉 구현으로 새는 시간을 막아줍니다.

## 무엇을 만드는가
한 줄 프롬프트 → 90초 뒤 **진짜 도메인에서 살아있는 웹앱**.
Daytona 샌드박스가 실행하고, DNSimple이 주소를 주고, Nosana가 보조 추론을 돌린다.

## 절대 제약
- **해커톤 2시간짜리다.** 동작하는 데모 > 좋은 코드. 항상.
- 추상화 금지. 인터페이스/베이스클래스/DI 금지. 함수 하나로 될 일은 함수 하나로.
- 테스트 코드 작성 금지. 대신 `scripts/test-*.ts` 로 **실제로 실행해서 눈으로 확인**한다.
- 의존성 추가는 최소. 새로 깔기 전에 Node 내장으로 되는지 먼저 생각할 것.
- 에러 핸들링은 "사용자에게 한 줄 메시지" 수준까지만. 재시도/서킷브레이커 금지.
- 모든 작업은 **검증 명령을 실행해서 통과시킨 뒤** 끝난 것으로 본다. 코드만 쓰고 끝내지 말 것.

## 아키텍처
```
브라우저(로컬) ── POST /api/ship ──> server.ts
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              generate.ts        sandbox.ts          dns.ts
             (Claude로 HTML)   (Daytona 실행 +      (DNSimple 레코드
                    │           preview URL)        + 라우터 등록)
                    │                 │                 │
                    └────── Nosana(아이콘/리뷰) ─────────┘
                                      │
                    https://<slug>.ship.<zone> ──> VPS Caddy ──> router:8080 ──> Daytona preview
```

## 검증된 API (추측 금지, 이대로 쓸 것)

**Daytona TS SDK**
```ts
const daytona = new Daytona()                       // DAYTONA_API_KEY 자동
const sandbox = await daytona.create({ language:'typescript', public:true, autoStopInterval:60 }, { timeout:120 })
await sandbox.process.executeCommand('...')
const link = await sandbox.getPreviewLink(3000)     // { url, token }
```

**DNSimple**
```
POST https://api.dnsimple.com/v2/{account}/zones/{zone}/records
Authorization: Bearer {token} / Accept: application/json / Content-Type: application/json
{ "name":"<slug>.ship", "type":"A", "content":"<ip>", "ttl":60 }
```

## 심사 기준 (모든 판단의 기준선)
1. MVP 완성도 — **미완성은 0점이다. 범위를 줄여서라도 끝낸다**
2. 아이디어 혁신성 — "에이전트가 자기 인프라를 소유한다"
3. 실제 문제 해결 — AI 생성 앱의 배포 라스트마일
4. **스폰서 통합 — Daytona / DNSimple / Nosana 셋 다 실제로 호출되어야 한다**

## 시간 예산
14:00 스캐폴드·샌드박스 / 14:45 DNS / 15:10 연결+QR / 15:30 Nosana / 15:45 리허설 / **16:00 데모**
15:45에는 무조건 코딩을 멈춘다.
