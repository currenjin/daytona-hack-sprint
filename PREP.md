# 전날 세팅 체크리스트 (Ship)

> 원칙: **계정·키·인프라·TLS까지만** 미리. 제품 코드는 14:00에.
> 이 선을 지키면 "룰 위반 아니냐" 질문이 나와도 방어됩니다.

당일 실패의 90%는 아이디어가 아니라 **인증서 / DNS 전파 / 키 발급**에서 납니다.
아래는 전부 오늘 밤에 끝내고, 각 항목마다 **검증 명령까지 실행해서 눈으로 확인**하세요.

---

## 1. DNSimple

- [ ] 계정 생성 + 도메인 1개 등록 (짧을수록 좋음 — 데모에서 소리 내어 읽습니다)
- [ ] Account API token 발급 (User token 아님 — Account token이면 Caddy에서 account_id 생략 가능)
- [ ] account ID 확인

```bash
export DNSIMPLE_TOKEN="..."
curl -s -H "Authorization: Bearer $DNSIMPLE_TOKEN" \
     -H "Accept: application/json" \
     https://api.dnsimple.com/v2/whoami
# → data.account.id 를 DNSIMPLE_ACCOUNT_ID 로 저장
```

- [ ] 와일드카드 A 레코드 생성 (`*.ship` → VPS IP), **TTL 60**

```bash
export DNSIMPLE_ACCOUNT_ID="..."
export ZONE="내도메인.com"
export VPS_IP="..."

curl -s -X POST \
  -H "Authorization: Bearer $DNSIMPLE_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"*.ship\",\"type\":\"A\",\"content\":\"$VPS_IP\",\"ttl\":60}" \
  https://api.dnsimple.com/v2/$DNSIMPLE_ACCOUNT_ID/zones/$ZONE/records
```

- [ ] **검증**: `dig +short abc123.ship.$ZONE` → VPS IP 가 나와야 함

> 참고: 레코드 CRUD 엔드포인트는 `/:account/zones/:zone/records` (POST/GET, DELETE는 `/records/:id`).
> 테스트만 할 거면 sandbox 환경(`https://api.sandbox.dnsimple.com`)도 있지만,
> **데모는 반드시 프로덕션 도메인으로** 하세요. 심사위원 폰에서 열려야 의미가 있습니다.

---

## 2. VPS + Caddy (와일드카드 TLS)

아무 $5 VPS나 됩니다 (Lightsail / Vultr / Oracle free tier). **공인 IP + 80/443 오픈**만 필요.

- [ ] xcaddy로 DNSimple 모듈 포함 Caddy 빌드

```bash
# Go 설치 후
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/dnsimple
sudo mv caddy /usr/local/bin/
```

- [ ] `Caddyfile` 배치 (이 폴더의 `Caddyfile` 참고) + 환경변수 주입
- [ ] Caddy 기동 후 **와일드카드 인증서가 실제로 발급됐는지 로그로 확인**

```bash
sudo caddy run --config /etc/caddy/Caddyfile 2>&1 | grep -i "certificate obtained"
```

- [ ] **검증**: `curl -I https://test.ship.$ZONE` → TLS 에러 없이 응답 (502여도 OK, TLS만 통과하면 성공)

> ⚠️ **당일에 인증서를 뽑으려 하지 마세요.** Let's Encrypt DNS-01은 전파 대기가 있고,
> rate limit에 걸리면 그날 하루가 끝납니다. 어젯밤에 발급받아 두면 캐시된 인증서를 그냥 씁니다.

### 플랜 B (VPS 없이 가는 길)
DNSimple에는 `URL` 타입 레코드(HTTP 리디렉트)가 있습니다. 슬러그마다 URL 레코드를 API로
만들면 프록시 없이도 `slug.ship.도메인` → Daytona preview URL 로 넘길 수 있습니다.
인프라 0, 구현 10분. 대신 주소창에 최종적으로 Daytona URL이 뜹니다(임팩트 하락).

**오늘 밤에 이게 HTTPS로도 되는지 반드시 직접 확인하세요.** URL 레코드의 HTTPS 지원 여부는
제가 확신할 수 없는 부분입니다. 레코드 하나 만들어서 `curl -I https://...` 로 때려보면 됩니다.

---

## 3. Daytona

- [ ] API 키 발급, `DAYTONA_API_KEY` 저장
- [ ] SDK 설치: `npm i @daytona/sdk`
- [ ] **검증 스크립트를 실제로 1회 성공시킬 것** — preview URL이 브라우저에서 열려야 함

```ts
import { Daytona } from '@daytona/sdk'

const daytona = new Daytona()                    // DAYTONA_API_KEY 환경변수 사용
const sandbox = await daytona.create({
  language: 'typescript',
  public: true,                                  // ★ 토큰 없이 접근 가능하게
  autoStopInterval: 60,
})
await sandbox.process.executeCommand('mkdir -p /app && cd /app && python3 -m http.server 3000 &')
const link = await sandbox.getPreviewLink(3000)
console.log(link.url)                            // ← 이 URL을 브라우저에서 열어볼 것
```

- [ ] 샌드박스 **콜드 스타트 실제 소요 시간 측정** → 데모 멘트에 그대로 씁니다
- [ ] **jsdom을 미리 깐 snapshot을 구워두기** (`npm i jsdom` 후 스냅샷 생성 → `DAYTONA_SNAPSHOT`)
      검증 단계에서 설치 시간 15~20초를 아낍니다
- [ ] 자주 쓸 구성을 **snapshot으로 미리 구워두기** (`daytona.create({ snapshot: '...' })`)
      → 당일 부팅 시간이 확 줄어듭니다. 이게 전날 준비 중 가장 ROI 높은 항목입니다.

---

## 4. 생성 엔진 (Nosana 또는 로컬)

- [ ] Nosana 대시보드에서 vLLM/Ollama 컨테이너 배포 → 노출된 URL 확보
- [ ] `.env` 에 `LLM_ENDPOINT=<URL>/v1`, `LLM_MODEL=<모델명>` 기입
- [ ] **크레딧 없이 먼저 테스트하려면 로컬 Ollama로 대체**:
      `ollama serve` → `LLM_ENDPOINT=http://localhost:11434/v1`, `LLM_MODEL=qwen2.5-coder:7b`
- [ ] `npm run preflight` 의 '생성 엔진' 항목이 초록인지 확인
- [ ] ⚠️ OpenAI 호환 `/chat/completions` 가 아니면 `lib/generate.ts` 의 요청/파싱 두 곳만 고치면 됩니다

---

## 5. 로컬

- [ ] `.env` 채우기 (`.env.example` 참고)
- [ ] `npm create vite@latest` 캐시 워밍 (오프라인 대비)
- [ ] **핸드폰 테더링 확인** — 현장 와이파이는 믿지 마세요
- [ ] 노트북 충전기 + 멀티탭 (3층, 엘리베이터 없음)
- [ ] 데모용 프롬프트 3개를 미리 정해서 **손에 익히기**
      (예: "홍대 라멘집 리뷰 사이트", "팀 회고 투표 페이지", "실시간 사다리타기")

---

## 6. 최종 리허설 (자기 전에 1회)

아래가 끊김 없이 되면 준비 끝입니다.

1. `dig +short 아무슬러그.ship.도메인` → VPS IP
2. `curl -I https://아무슬러그.ship.도메인` → TLS 통과
3. Daytona 샌드박스 생성 → preview URL 브라우저에서 열림
4. DNSimple API로 레코드 생성/삭제 왕복
5. Nosana 추론 1회 응답
