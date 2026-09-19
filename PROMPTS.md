# 당일 프롬프트 키트 (14:00–16:00)

사용법: 각 블록을 **그대로 복붙**. 하나가 "완료 조건"을 통과하기 전에는 다음으로 넘어가지 마세요.
시간이 밀리면 **P5(Nosana)를 버리지 말고 P4(UI)를 줄이세요.** 스폰서 통합이 심사 기준이고,
UI는 못생겨도 감점이 적습니다.

프롬프트 설계 원칙 3가지 — 당일에 즉흥으로 프롬프트를 쓸 때도 이걸 지키세요:
1. **완료 조건을 숫자로** 준다 (에이전트가 언제 멈출지 알아야 함)
2. **하지 말 것을 명시**한다 (2시간짜리에서 과잉 구현이 최대 적)
3. **검증 명령을 같이** 준다 (에이전트가 스스로 확인하고 끝냄)

---

## P0 — 스캐폴드 (13:30, 워크숍 들으면서)

```
Node 20 + TypeScript 프로젝트를 만들어줘. 목적은 해커톤 데모용 웹앱이고, 앞으로 2시간 안에 끝내야 해.

구조:
- server.ts : Express 서버, 포트 5173. 정적 파일은 public/ 에서 서빙.
- public/index.html : 프롬프트 입력창 + 로그 출력 영역 + 결과 영역. 단일 파일, 인라인 CSS/JS. 다크 테마.
- lib/ : 비어 있는 디렉토리
- .env 를 dotenv로 로드. 필요한 키: DAYTONA_API_KEY, DNSIMPLE_TOKEN, DNSIMPLE_ACCOUNT_ID, DNSIMPLE_ZONE, ANTHROPIC_API_KEY, ROUTER_URL, ROUTER_SECRET

서버는 SSE(/api/stream)로 로그를 브라우저에 밀어주는 구조로 만들어줘. 클라이언트는 EventSource로 받아서 로그 영역에 append.

의존성은 최소로: express, dotenv, @daytona/sdk 만.

하지 말 것: 인증, DB, 테스트, 빌드 도구(webpack/vite), 라우터 라이브러리, 에러 바운더리 과설계.

완료 조건: `npm run dev` 로 서버가 뜨고, 브라우저에서 localhost:5173 열면 입력창이 보이고,
서버가 2초마다 보내는 더미 로그가 화면에 흐른다.
```

---

## P1 — Daytona 샌드박스 → preview URL (14:00, 25분)

**이게 가장 중요한 블록입니다. 여기가 안 되면 프로젝트가 없습니다.**

```
lib/sandbox.ts 를 만들어줘. Daytona TypeScript SDK(@daytona/sdk)를 쓴다.

검증된 API 시그니처 (추측하지 말고 이대로 써):
  import { Daytona } from '@daytona/sdk'
  const daytona = new Daytona()                       // DAYTONA_API_KEY 환경변수 자동 사용
  const sandbox = await daytona.create({
    language: 'typescript',
    public: true,                                     // 토큰 없이 preview 접근
    autoStopInterval: 60,
  }, { timeout: 120 })
  await sandbox.process.executeCommand('...')          // 쉘 명령
  const link = await sandbox.getPreviewLink(3000)      // → { url, token }

export 할 함수 하나:
  async function launchSandbox(files: Record<string,string>, onLog: (s:string)=>void): Promise<{ sandboxId: string, previewUrl: string }>

동작:
1. 샌드박스 생성 (onLog로 진행상황 보고)
2. files의 각 경로/내용을 샌드박스 /app 아래에 기록 (executeCommand + heredoc 또는 base64 디코드 — 따옴표 이스케이프 안전하게)
3. /app 에서 정적 서버를 백그라운드로 띄운다 (python3 -m http.server 3000). 백그라운드 실행이 executeCommand 반환 후에도 살아있게 nohup + & 처리.
4. getPreviewLink(3000) 으로 URL 얻어서 반환

하지 말 것: 재시도 로직, 샌드박스 풀링, 상태 저장.

완료 조건: `npx tsx scripts/test-sandbox.ts` 를 만들어서 실행하면
{ "hello world" 가 든 index.html } 을 넣고 preview URL을 콘솔에 출력하고,
그 URL을 curl 했을 때 실제로 hello world 가 나온다. curl 로 직접 확인까지 해줘.
```

> ⚠️ 여기서 15분 넘게 막히면 **즉시 P1-fallback**으로 전환:
> 샌드박스 안에서 서버 띄우는 걸 포기하고, Daytona는 "코드 생성/실행 전용"으로만 쓰고
> 호스팅은 VPS의 Caddy가 정적 파일을 직접 서빙하게 합니다. 스폰서 통합은 유지됩니다.

---

## P2 — 프롬프트 → 앱 코드 생성 (14:25, 20분)

```
lib/generate.ts 를 만들어줘.

export async function generateApp(userPrompt: string, onLog: (s:string)=>void): Promise<Record<string,string>>

OpenAI 호환 엔드포인트(LLM_ENDPOINT, Nosana GPU 또는 로컬 Ollama)를 stream:true 로 호출해서, 사용자의 한 줄 요청을
"의존성 없는 단일 index.html" 로 만든다. 인라인 CSS/JS, 외부 CDN 금지(오프라인에서도 떠야 함).

시스템 프롬프트에 반드시 넣을 것:
- 반드시 완성된 단일 HTML 문서만 출력. 설명/마크다운 코드펜스 금지.
- 다크 테마, 모바일 우선. 심사위원이 휴대폰으로 볼 것이다.
- 첫 화면에서 바로 뭔가 동작해야 한다. 빈 상태 금지 — 더미 데이터를 미리 채워라.

반환값은 { 'index.html': '<!doctype html>...' } 형태.
응답에 코드펜스가 섞여 오면 벗겨내는 방어 코드 한 줄만 넣어줘.

하지 말 것: 멀티파일 지원, 프레임워크, 스트리밍 파싱, 토큰 계산.

완료 조건: scripts/test-generate.ts 로 "홍대 라멘집 리뷰 사이트" 를 넣으면
유효한 HTML이 나오고, /tmp 에 저장해서 브라우저로 열었을 때 실제로 렌더링된다.
```

---

## P3 — DNSimple 레코드 + 라우터 (14:45, 25분)

**차별화 지점. 여기를 반드시 통과시키세요.**

```
두 개를 만들어줘.

(A) VPS에 올릴 라우터 — router/index.js (순수 Node, 의존성 0)
  포트 8080. 두 가지 일만 한다:
  - POST /_register  { slug, target, secret }  → 메모리 맵에 slug→target 저장. secret이 ROUTER_SECRET과 다르면 403.
  - 그 외 모든 요청 → Host 헤더에서 slug 추출(`<slug>.ship.<zone>`) → 맵에서 target 조회 →
    해당 URL로 프록시(https 요청 후 응답 파이프). 없으면 404 + "아직 배포되지 않았습니다" 안내 HTML.
  프록시는 node:https 로 직접. 리다이렉트 1회까지 따라가게.

(B) lib/dns.ts — 로컬에서 호출
  export async function publish(slug: string, previewUrl: string, onLog): Promise<string>
  1. 라우터에 POST /_register (ROUTER_URL, ROUTER_SECRET 사용)
  2. DNSimple API로 레코드 생성 — 아래 시그니처 그대로:
       POST https://api.dnsimple.com/v2/{DNSIMPLE_ACCOUNT_ID}/zones/{DNSIMPLE_ZONE}/records
       headers: Authorization: Bearer {DNSIMPLE_TOKEN}, Accept: application/json, Content-Type: application/json
       body: { "name": "<slug>.ship", "type": "A", "content": "<VPS_IP>", "ttl": 60 }
     ※ 와일드카드 레코드가 이미 있으므로 이 개별 레코드는 기능상 불필요하지만,
       "에이전트가 DNS 레코드를 실제로 만든다"는 걸 데모에서 보여주기 위해 만든다.
       409(이미 존재)는 성공으로 처리.
  3. `https://<slug>.ship.<zone>` 반환
  4. 반환 직전에 그 URL을 최대 10회, 1초 간격으로 폴링해서 200이 뜰 때까지 대기 (onLog로 진행 표시)

slug는 사용자 프롬프트에서 영문 슬러그로 생성 (한글이면 짧은 랜덤 영문 + 숫자).

하지 말 것: 레코드 갱신/삭제, 충돌 해결, TTL 튜닝.

완료 조건: scripts/test-publish.ts 로 임의 slug와 아무 https URL을 넘기면
https://<slug>.ship.<zone> 가 브라우저에서 그 내용을 보여준다. curl로 확인까지.
```

---

## P4 — 전체 연결 + QR (15:10, 20분)

```
server.ts 에 POST /api/ship 을 추가해서 P2 → P1 → P3 를 순서대로 엮어줘.
각 단계 로그는 SSE로 실시간 전송. 단계 표시는 이렇게:

  [1/4] 앱 설계 중...
  [2/4] Daytona 샌드박스 부팅...
  [3/4] DNS 레코드 생성...
  [4/4] 라이브!

완료되면 클라이언트에 최종 URL 전송. public/index.html 은:
- URL을 아주 크게 표시 (폰트 32px 이상, 클릭 가능)
- 그 아래 QR 코드를 크게(280px 이상) 렌더링
  → QR은 외부 라이브러리 없이. qrcode 패키지를 서버에서 써서 data-URI PNG로 내려주는 게 제일 빠름.
- 경과 시간 타이머를 상단에 표시 (데모에서 "90초" 를 증명하는 장치)

하지 말 것: 애니메이션 튜닝, 반응형 세부 조정, 히스토리 목록.

완료 조건: 브라우저에서 "팀 회고 투표 페이지" 입력 → 로그 흐름 → URL + QR 표시 →
실제 휴대폰으로 QR 찍어서 페이지가 열린다. 폰으로 반드시 직접 확인할 것.
```

---

## P5 — 자가 수정 루프 (15:30, 15분)

```
검증 실패 시 스스로 고치는 루프를 붙여줘.

lib/generate.ts 에 repairApp(html, issues, onLog) 추가:
  검증기가 뱉은 문제 목록을 프롬프트에 넣고 "고친 전체 HTML을 다시 출력" 시킨다.
  디자인/기능은 유지하고 문제된 부분만 고치라고 명시.

server.ts 의 /api/ship:
  verdict = verifyApp(...) 이 실패하면
    → repairApp → deployFiles(같은 샌드박스에 덮어쓰기) → verifyApp 재실행
  최대 1회만. 두 번째도 실패하면 문제를 안고 출시하되 로그에 남긴다.
  각 단계마다 SSE로 verify 이벤트를 보내서 화면에 체크리스트가 갱신되게.

완료 조건: 일부러 깨진 HTML을 넣었을 때 검증 실패 → 수정 → 재검증 통과가 화면에 보인다.
```

> 시간이 없으면 이미지 대신 **"생성된 앱 코드를 Nosana 오픈모델로 보안 리뷰"** 가 더 쉽고
> 스토리도 좋습니다 (텍스트 in/out 1회 호출이면 끝).

---

## P6 — 리허설 (15:45, 15분)

```
데모 안정화만 한다. 새 기능 금지.

1. /api/ship 전체를 서로 다른 프롬프트 3개로 연속 실행. 각각 몇 초 걸리는지 측정해서 알려줘.
2. 실패 지점마다 사용자에게 보이는 메시지를 사람 말로 바꿔줘 (스택트레이스 노출 금지).
3. 네트워크가 끊겼을 때 프론트가 무한 로딩에 빠지지 않게 60초 타임아웃 + 안내 문구.
4. README.md 에 아키텍처 5줄 + 스폰서별 사용처를 Daytona/DNSimple/Nosana 각 1줄로 정리.
```

그리고 **사람이 할 일** (에이전트한테 시키지 말 것):
- [ ] 성공 플로우 **화면 녹화** — 라이브 데모 실패 시 이걸 틀어야 합니다
- [ ] 아키텍처 1장짜리 슬라이드 (박스 3개 + 화살표. 5분이면 충분)
- [ ] 데모 멘트 **소리 내어 2번** 연습
- [ ] 발표 노트북에서 배터리 절전 모드 끄기, 알림 끄기, 브라우저 탭 정리

---

## 데모 3분 대본

| 초 | 내용 |
|---|---|
| 0–20 | "AI가 만든 앱은 검증도 없이 localhost에서 죽습니다." |
| 20–50 | 프롬프트 입력 → 생성 → 샌드박스에서 실행 (타이머 보이게) |
| 50–80 | **검증 체크리스트에 ✗ → 스스로 수정 → 재검증 ✓** ← 첫 클라이맥스 |
| 80–110 | 주소 + QR 등장 → **"지금 다들 폰으로 찍어보세요"** ← 승부처 |
| 110–140 | "폰트 키워줘" → 같은 주소가 그 자리에서 갱신 |
| 140–170 | 아키텍처 1장: Daytona(실행·검증) / Nosana(생성) / DNSimple(주소) |
| 170–180 | "에이전트가 자기 결과물을 책임지고 출시합니다." |

2분으로 줄면 110–140 구간(수정 요청)을 버립니다.
80–110초 구간에서 심사위원 손이 주머니로 가면 사실상 끝난 겁니다.

### 데모를 확실하게 만드는 장치
검증 실패 장면이 매번 나오라는 보장은 없습니다. **일부러 깨지는 프롬프트를 하나 준비**해두세요
(예: 복잡한 상태 관리가 필요한 앱). 리허설 때 어떤 프롬프트가 수정 루프를 타는지 기록해두고,
데모에서는 그 프롬프트를 씁니다.