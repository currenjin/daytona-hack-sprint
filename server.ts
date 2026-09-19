import express from 'express'
import QRCode from 'qrcode'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PORT } from './lib/env.js'
import { activeProvider, extractTitle, generateApp, repairApp } from './lib/generate.js'
import { deployFiles, launchSandbox } from './lib/sandbox.js'
import { ensureJsdom, verifyApp } from './lib/verify.js'
import { publish } from './lib/dns.js'
import { makeSlug } from './lib/slug.js'

const here = dirname(fileURLToPath(import.meta.url))
const app = express()

const MAX_REPAIRS = 1 // 데모 시간 예산상 1회. 두 번째 실패는 문제를 안고 출시한다.

/**
 * SDK 내부 에러를 데모 중에 읽고 바로 손쓸 수 있는 한 줄로 바꾼다.
 * 심사위원 앞에서 영문 스택트레이스가 뜨는 것만은 피한다.
 */
function friendly(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  // 우리가 이미 한국어로 던진 에러는 그대로 통과 (아래 규칙이 덮어쓰지 않도록 먼저).
  if (/[가-힣]/.test(raw) && !raw.includes('\n') && raw.length < 160) return raw

  if (/authentication method|api[_ ]?key/i.test(raw)) {
    if (!process.env.DAYTONA_API_KEY) return '.env 의 DAYTONA_API_KEY 가 비어 있습니다.'
    return 'API 키 인증에 실패했습니다. .env 를 확인하세요.'
  }
  if (/401|unauthorized/i.test(raw)) return 'API 키가 거부됐습니다 (401). 키가 만료됐는지 확인하세요.'
  if (/429|rate.?limit/i.test(raw)) return '요청 한도에 걸렸습니다. 30초 뒤 다시 시도하세요.'
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(raw)) {
    return '네트워크 연결이 끊겼습니다. 테더링으로 바꾸고 다시 시도하세요.'
  }
  if (/timeout|timed out/i.test(raw)) return '외부 서비스 응답이 너무 느립니다. 다시 시도하세요.'

  return raw.split('\n')[0]!.slice(0, 160)
}

app.use(express.json({ limit: '1mb' }))
app.use(express.static(join(here, 'public')))

app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/ship', async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim()

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: string, data: unknown) => {
    res.write(`data: ${JSON.stringify({ event, ...(data as object) })}\n\n`)
  }
  const log = (message: string) => send('log', { message })

  if (!prompt) {
    send('error', { message: '만들고 싶은 것을 한 줄로 적어주세요.' })
    return res.end()
  }

  const started = Date.now()
  // 네트워크가 끊겨도 프론트가 무한 로딩에 빠지지 않도록.
  const timeout = setTimeout(() => {
    send('error', { message: '3분을 넘겨서 중단했습니다. 다시 시도해주세요.' })
    res.end()
  }, 180_000)

  try {
    send('step', { index: 1, total: 4, label: '앱 생성' })
    let files = await generateApp(prompt, log)
    const title = extractTitle(files['index.html']!)
    send('title', { title })

    send('step', { index: 2, total: 4, label: '격리 실행' })
    const { sandbox, previewUrl } = await launchSandbox(files, log)
    await ensureJsdom(sandbox, log)

    send('step', { index: 3, total: 4, label: '자기 검증' })
    let verdict = await verifyApp(sandbox, log)
    send('verify', { ok: verdict.ok, checks: verdict.checks, repaired: false })

    // 검증 실패 → 문제를 모델에 되먹여 고치고 재배포 → 재검증
    let repairs = 0
    while (!verdict.ok && repairs < MAX_REPAIRS) {
      repairs++
      send('step', { index: 3, total: 4, label: `자가 수정 (${repairs}차)` })
      files = await repairApp(files['index.html']!, verdict.issues, log)
      await deployFiles(sandbox, files, log)
      verdict = await verifyApp(sandbox, log)
      send('verify', { ok: verdict.ok, checks: verdict.checks, repaired: true })
    }

    if (!verdict.ok) {
      log(`남은 문제 ${verdict.issues.length}건 — 그대로 출시합니다`)
    }

    send('step', { index: 4, total: 4, label: '출시' })
    const slug = makeSlug(prompt)
    const url = await publish(slug, previewUrl, log)
    const qr = await QRCode.toDataURL(url, {
      width: 480,
      margin: 1,
      color: { dark: '#0b0d10', light: '#ffffff' },
    })

    clearTimeout(timeout)
    send('done', {
      url,
      qr,
      title,
      previewUrl,
      repairs,
      verified: verdict.ok,
      checks: verdict.checks,
      elapsedMs: Date.now() - started,
    })
  } catch (err) {
    clearTimeout(timeout)
    console.error('[ship]', err) // 전체 스택은 터미널에만, 화면에는 한 줄만
    send('error', { message: friendly(err) })
  } finally {
    res.end()
  }
})

app.listen(PORT, () => {
  console.log(`\n  Ship → http://localhost:${PORT}`)

  // 데모 5분 전에 설정이 빠진 걸 발견하는 사태를 막는다.
  try {
    console.log(`  생성 엔진: ${activeProvider().label}`)
  } catch (err) {
    console.log(`  ⚠️  ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!process.env.DAYTONA_API_KEY) console.log('  ⚠️  DAYTONA_API_KEY 없음 — .env 를 확인하세요')
  if (!process.env.DNSIMPLE_ZONE) console.log('  ℹ️  DNSIMPLE_ZONE 미설정 — Daytona preview URL로 폴백합니다')
  console.log()
})
