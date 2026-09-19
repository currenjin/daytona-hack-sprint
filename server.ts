import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PORT } from './lib/env.js'
import { activeProvider } from './lib/generate.js'
import { parsePr } from './lib/github.js'
import { runCollisionAnalysis } from './lib/engine.js'
import { nosanaCredits } from './lib/credits.js'
import { loadReport, saveReport } from './lib/reports.js'
import { renderFailureSvg, renderSuccessSvg, type PrReport } from './lib/svg.js'

const here = dirname(fileURLToPath(import.meta.url))
const app = express()

/** SDK 내부 에러를 데모 중에 읽을 수 있는 한 줄로. */
function friendly(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/[가-힣]/.test(raw) && !raw.includes('\n') && raw.length < 200) return raw
  if (/authentication method|api[_ ]?key/i.test(raw)) {
    if (!process.env.DAYTONA_API_KEY) return '.env 의 DAYTONA_API_KEY 가 비어 있습니다.'
    return 'API 키 인증에 실패했습니다. .env 를 확인하세요.'
  }
  if (/401|unauthorized/i.test(raw)) return 'API 키가 거부됐습니다 (401).'
  if (/429|rate.?limit/i.test(raw)) return '요청 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.'
  if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(raw)) return '네트워크가 끊겼습니다.'
  if (/gh:|gh not found|ENOENT/i.test(raw)) return 'gh CLI 를 찾을 수 없거나 인증되지 않았습니다.'
  return raw.split('\n')[0]!.slice(0, 180)
}

app.use(express.json({ limit: '4mb' }))
app.use(express.static(join(here, 'public')))

app.get('/healthz', (_req, res) => res.json({ ok: true }))
app.get('/api/credits', async (_req, res) => res.json({ nosana: await nosanaCredits() }))

app.post('/api/collide', async (req, res) => {
  const raw: unknown = req.body?.prs
  const inputs = (Array.isArray(raw) ? raw : []).map((x) => String(x).trim()).filter(Boolean)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: string, data: unknown) =>
    res.write(`data: ${JSON.stringify({ event, ...(data as object) })}\n\n`)

  if (inputs.length < 2) {
    send('error', { message: 'PR 을 두 개 이상 입력하세요 (예: owner/repo#1)' })
    return res.end()
  }

  try {
    const refs = inputs.map(parsePr)
    const repo = refs[0]!.repo
    if (refs.some((r) => r.repo !== repo)) throw new Error('PR 이 모두 같은 레포여야 합니다')

    // 웹과 CI 가 같은 엔진을 쓴다. 이벤트만 SSE 로 흘려보낸다.
    await runCollisionAnalysis({
      repo,
      numbers: refs.map((r) => r.number),
      onEvent: (e) => send(e.event, e),
    })
  } catch (err) {
    console.error('[collider]', err)
    send('error', { message: friendly(err) })
  } finally {
    res.end()
  }
})

/** CI 러너가 분석 결과를 올린다. 돌려준 URL 이 PR 코멘트에 들어간다. */
app.post('/api/reports', async (req, res) => {
  try {
    const report = req.body as PrReport
    if (!report?.currentPr?.number) return res.status(400).json({ error: 'currentPr 이 없습니다' })
    const id = await saveReport(report)
    res.json({ id, svgPath: `/reports/${id}.svg`, reportPath: `/reports/${id}` })
  } catch (err) {
    res.status(500).json({ error: friendly(err) })
  }
})

app.get('/reports/:id.svg', async (req, res) => {
  const report = await loadReport(String(req.params.id))
  if (!report) return res.status(404).type('text/plain').send('not found')
  res.type('image/svg+xml')
  // GitHub 은 코멘트 이미지를 자기 프록시로 캐시한다. 재검사 결과가 옛 그림으로
  // 보이지 않도록 캐시를 짧게 잡는다.
  res.set('cache-control', 'public, max-age=60')
  res.send(report.collision ? renderFailureSvg(report) : renderSuccessSvg(report))
})

app.get('/reports/:id', async (req, res) => {
  const report = await loadReport(String(req.params.id))
  if (!report) return res.status(404).type('text/plain').send('not found')
  res.type('html').send(reportPage(report))
})

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

/** 상세 리포트. 웹 대시보드와 같은 색과 타이포를 쓴다. */
function reportPage(r: PrReport): string {
  const rows = r.checkedPrs
    .map((p) => {
      const hit = r.collision?.withPr === p.number
      return `<tr><td>#${p.number}</td><td>${esc(p.title)}</td><td class="${
        hit ? 'bad' : 'good'
      }">${hit ? 'collision' : 'no collision'}</td></tr>`
    })
    .join('')

  const detail = r.collision
    ? `<section class="card bad-card">
         <h2>Collides with #${r.collision.withPr}</h2>
         <p>${esc(r.collision.withPrTitle)}</p>
         <dl>
           <dt>What breaks</dt><dd>${esc(r.collision.impact)}</dd>
           <dt>Expected</dt><dd>${esc(r.collision.expected)}</dd>
           <dt>Actual</dt><dd class="bad">${esc(r.collision.actual)}</dd>
         </dl>
       </section>`
    : `<section class="card"><h2>No collision found in checked combinations</h2>
         <p>${r.checkedPrs.length} / ${r.checkedPrs.length} combinations passed.</p></section>`

  const existing = r.existingTests
    ? `<p class="muted">Existing tests ${r.existingTests.passed} / ${r.existingTests.total} passed before the interaction test ran.</p>`
    : ''

  return `<!doctype html><meta charset="utf-8">
<title>Collider · ${esc(r.repo)} #${r.currentPr.number}</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:820px;margin:48px auto;padding:0 20px;color:#111}
h1{font-size:20px;margin:0 0 4px}
.muted{color:#666}
.card{border:1px solid #e3e5e8;border-radius:12px;padding:20px 24px;margin:20px 0}
.bad-card{border-color:#f0b4b4;background:#fff7f7}
.bad{color:#b42318}.good{color:#067647}
dl{display:grid;grid-template-columns:140px 1fr;gap:6px 16px;margin:12px 0 0}
dt{color:#666}dd{margin:0;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;margin-top:8px}
td{padding:8px 0;border-bottom:1px solid #eef0f2}
@media (prefers-color-scheme:dark){
  body{color:#e8eaed;background:#111315}
  .card{border-color:#2a2e33}.bad-card{background:#1d1414;border-color:#5a2a2a}
  td{border-color:#24282c}.muted,dt{color:#8b9199}
}
</style>
<h1>Collider report</h1>
<p class="muted">${esc(r.repo)} · PR #${r.currentPr.number} ${esc(r.currentPr.title)}</p>
${detail}
${existing}
<section class="card"><h2>Checked combinations</h2><table>${rows}</table></section>
`
}

app.listen(PORT, () => {
  console.log(`\n  Collider → http://localhost:${PORT}`)
  try {
    console.log(`  분석 엔진: ${activeProvider().label}`)
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!process.env.DAYTONA_API_KEY) console.log('  DAYTONA_API_KEY 없음')
  nosanaCredits().then((c) => {
    if (c) console.log(`  Nosana 크레딧 ${c.free.toFixed(2)} / ${c.assigned} (${c.level})`)
    console.log()
  })
})
