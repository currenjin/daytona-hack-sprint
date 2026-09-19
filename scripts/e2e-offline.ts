/**
 * 키 없이 돌릴 수 있는 구간 전체를 실제 모듈로 연결해서 검증한다.
 * 가짜로 대체하는 것은 오직 두 개: Claude 호출(=미리 만든 HTML), Daytona 샌드박스(=로컬 정적 서버).
 * 나머지(슬러그, 타이틀 추출, 라우터 등록, 프록시 체인, 폴백, QR, 서버 SSE)는 전부 진짜다.
 */
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import QRCode from 'qrcode'

import { APP_DIR, PORT as PORT_APP } from '../lib/sandbox.js'
import { VERIFY_JS } from '../lib/verify.js'

import { publish } from '../lib/dns.js'
import { makeSlug } from '../lib/slug.js'
import { extractTitle } from '../lib/generate.js'

const ROUTER_PORT = 8099
const FAKE_SANDBOX_PORT = 8098
const pass: string[] = []
const fail: string[] = []

function check(name: string, ok: boolean, detail = '') {
  ;(ok ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// Claude가 만들었다고 가정한 앱 (실제 generateApp 출력 형태와 동일)
const GENERATED_HTML = `<!doctype html><html lang="ko"><meta charset="utf-8">
<title>홍대 라멘집 리뷰</title>
<body style="background:#0b0d10;color:#e8eaed;font:16px system-ui;margin:0;padding:24px">
<h1 style="color:#5eead4">홍대 라멘집 리뷰</h1>
<ul id="list"><li>이치란 — ★★★★☆</li><li>멘야산다이메 — ★★★★★</li></ul>
<script>document.getElementById('list').onclick=(e)=>e.target.style.opacity=.5</script>
</body></html>`

console.log('\n[1] 로컬 스텁 기동 (Daytona preview 대역)\n')

const fakeSandbox = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(GENERATED_HTML)
})
await new Promise<void>((r) => fakeSandbox.listen(FAKE_SANDBOX_PORT, r))
const previewUrl = `http://127.0.0.1:${FAKE_SANDBOX_PORT}`
check('가짜 샌드박스 기동', true, previewUrl)

const router = spawn('node', ['router/index.js'], {
  cwd: '/Users/currenjin/daytona-hack-sprint',
  env: { ...process.env, PORT: String(ROUTER_PORT), ROUTER_SECRET: 'e2e', ROUTER_STORE: '/tmp/e2e-routes.json' },
  stdio: 'ignore',
})
await new Promise((r) => setTimeout(r, 800))
check('라우터 기동', true, `:${ROUTER_PORT}`)

console.log('\n[2] 순수 로직\n')

const prompt = '홍대 라멘집 리뷰 사이트'
const slug = makeSlug(prompt)
check('슬러그 생성 (한글 → ASCII 폴백)', /^[a-z]+-\d{3}$/.test(slug), slug)
check('슬러그가 유효한 DNS 라벨', /^[a-z0-9-]{1,63}$/.test(slug) && !slug.startsWith('-'), slug)

const title = extractTitle(GENERATED_HTML)
check('타이틀 추출', title === '홍대 라멘집 리뷰', title)

console.log('\n[3] publish() — DNSimple 미설정 시 폴백\n')

process.env.ROUTER_URL = `http://127.0.0.1:${ROUTER_PORT}`
process.env.ROUTER_SECRET = 'e2e'
delete process.env.DNSIMPLE_ZONE

const logs1: string[] = []
const url1 = await publish(slug, previewUrl, (m) => logs1.push(m))
check('DNSIMPLE_ZONE 없으면 preview URL 반환', url1 === previewUrl, url1)
check('그 경우 라우터 등록도 건너뜀', logs1.some((l) => l.includes('preview URL을 그대로')))

console.log('\n[4] publish() — 라우터 등록 + 도메인 미응답 시 폴백\n')

process.env.DNSIMPLE_ZONE = 'e2e-nonexistent-zone.invalid'
const logs2: string[] = []
const t0 = Date.now()
const url2 = await publish(slug, previewUrl, (m) => logs2.push(m))
const elapsed = Date.now() - t0

check('라우터 등록 성공', logs2.some((l) => l.includes('라우터 등록 완료')))
check('DNSimple 설정 미완료를 감지', logs2.some((l) => l.includes('DNSimple 설정 미완료')))
check('전파 재시도 후 preview URL로 폴백', url2 === previewUrl, `${(elapsed / 1000).toFixed(1)}s 후 폴백`)
check('폴백이 60초 데모 타임아웃 안에 끝남', elapsed < 20000, `${(elapsed / 1000).toFixed(1)}s`)

console.log('\n[5] 프록시 체인 — 등록된 slug로 앱이 실제 서빙되는가\n')

// undici(Node fetch)는 Host 헤더를 금지 헤더로 보고 조용히 버린다.
// 라우터는 Host로 slug를 판별하므로 여기서는 node:http 를 직접 쓴다.
function getWithHost(host: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: ROUTER_PORT, path: '/', headers: { Host: host } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
  })
}

const viaRouter = await getWithHost(`${slug}.ship.example.dev`)
check('라우터 → 샌드박스 프록시 200', viaRouter.status === 200, `HTTP ${viaRouter.status}`)
check(
  '생성된 앱이 그대로 전달됨',
  viaRouter.body.includes('홍대 라멘집 리뷰') && viaRouter.body.includes('멘야산다이메'),
)
check('content-type 보존', String(viaRouter.headers['content-type'] ?? '').includes('text/html'))

const miss = await getWithHost('unknown.ship.example.dev')
check('미등록 slug → 404 안내 페이지', miss.status === 404 && miss.body.includes('아직 배포되지'))

console.log('\n[6] QR 코드\n')

const qr = await QRCode.toDataURL(`https://${slug}.ship.example.dev`, { width: 480, margin: 1 })
check('QR data URI 생성', qr.startsWith('data:image/png;base64,'), `${(qr.length / 1024).toFixed(1)}KB`)

console.log('\n[7] 서버 SSE 계약 — 키 없을 때의 실패 UX\n')

const server = spawn('npx', ['tsx', 'server.ts'], {
  cwd: '/Users/currenjin/daytona-hack-sprint',
  env: { ...process.env, PORT: '5199', ANTHROPIC_API_KEY: '' },
  stdio: 'ignore',
})
await new Promise((r) => setTimeout(r, 4000))

const sse = await fetch('http://127.0.0.1:5199/api/ship', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt }),
})
const raw = await sse.text()
const events = raw
  .split('\n\n')
  .filter((c) => c.trim().startsWith('data:'))
  .map((c) => JSON.parse(c.trim().slice(5)))

check('SSE 프레임이 파싱 가능한 형태', events.length > 0, `${events.length}개 이벤트`)
check('첫 이벤트가 step 1/4', events[0]?.event === 'step' && events[0]?.index === 1)
check('키 없으면 error 이벤트로 끝남', events.at(-1)?.event === 'error')
const errMsg = String(events.at(-1)?.message ?? '')
check(
  '에러가 한국어 한 줄 (스택트레이스 아님)',
  /[가-힣]/.test(errMsg) && !errMsg.includes('\n') && errMsg.length < 160,
  errMsg,
)

server.kill()

console.log('\n[8] 검증기 — 깨진 앱을 실제로 잡아내는가\n')

// 샌드박스에서 도는 것과 '동일한' 검증기 소스를 로컬에서 실행한다.
// APP_DIR(/tmp/app)을 읽고 :3000 을 찌르므로 그 환경을 그대로 재현한다.
const BROKEN = `<!doctype html><html><head><title>broken</title></head>
<body><button id="b">click</button><p>${'테스트 본문. '.repeat(20)}</p>
<script>document.getElementById('b').onclick = () => { alert('hi' }</script>
</body></html>`

const GOOD = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>good app</title></head>
<body><h1>투표</h1><p>${'실제 내용이 들어 있는 본문. '.repeat(12)}</p>
<button id="b">누르기</button><span id="n">0</span>
<script>
  var n = 0;
  document.getElementById('b').addEventListener('click', function () {
    n += 1; document.getElementById('n').textContent = String(n);
  });
</script>
</body></html>`

fs.mkdirSync(APP_DIR, { recursive: true })

// /tmp/app 을 :3000 으로 서빙 (검증기의 '서버 200 응답' 체크 대상)
const appServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(fs.readFileSync(join(APP_DIR, 'index.html')))
})
await new Promise<void>((r) => appServer.listen(PORT_APP, r))

// jsdom 을 resolve 하려면 프로젝트 node_modules 옆에서 실행해야 한다
const verifyPath = join(process.cwd(), '.verify-tmp.cjs')
fs.writeFileSync(verifyPath, VERIFY_JS)

// execFileSync 는 이벤트 루프를 막아 로컬 서버가 응답하지 못한다 — 반드시 비동기로.
const execFileAsync = promisify(execFile)
async function runVerifier(): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const { stdout } = await execFileAsync('node', [verifyPath], { encoding: 'utf8' })
  const out = stdout.trim()
  return JSON.parse(out.slice(out.indexOf('{'))).checks
}

fs.writeFileSync(join(APP_DIR, 'index.html'), BROKEN)
const brokenChecks = await runVerifier()
const syntaxCheck = brokenChecks.find((c) => c.name === '인라인 스크립트 문법')
check('깨진 앱 — 문법 오류 적발', syntaxCheck?.ok === false, syntaxCheck?.detail.slice(0, 60))
check('깨진 앱 — 전체 판정 실패', brokenChecks.some((c) => !c.ok))

fs.writeFileSync(join(APP_DIR, 'index.html'), GOOD)
const goodChecks = await runVerifier()
const goodFailed = goodChecks.filter((c) => !c.ok)
check('정상 앱 — 전체 통과', goodFailed.length === 0, goodFailed.map((c) => c.name).join(', '))
check(
  'jsdom 런타임 경로가 실제로 돌았음',
  goodChecks.some((c) => c.name === '스크립트 실행') && goodChecks.some((c) => c.name === '클릭 동작'),
  goodChecks.map((c) => c.name).join(' · '),
)

fs.rmSync(verifyPath, { force: true })
appServer.close()
router.kill()
fakeSandbox.close()

console.log('\n' + '─'.repeat(64))
console.log(`${pass.length}/${pass.length + fail.length} 통과`)
if (fail.length) {
  console.log('\n실패:')
  for (const f of fail) console.log(`  · ${f}`)
  process.exitCode = 1
}
