import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PORT } from './lib/env.js'
import { activeProvider } from './lib/generate.js'
import { fetchPr, findSpec, parsePr } from './lib/github.js'
import { hypothesize, writeInteractionTest } from './lib/interaction.js'
import {
  extractAssertion,
  mergeFutures,
  listSourceFiles,
  readSampleTest,
  runExistingTests,
  runInteractionTest,
} from './lib/collide.js'
import { generateWithCache } from './lib/cache.js'
import { publish } from './lib/dns.js'
import { makeSlug } from './lib/slug.js'

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

app.use(express.json({ limit: '1mb' }))
app.use(express.static(join(here, 'public')))

app.get('/healthz', (_req, res) => res.json({ ok: true }))

app.post('/api/collide', async (req, res) => {
  const inputA = String(req.body?.prA ?? '').trim()
  const inputB = String(req.body?.prB ?? '').trim()

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: string, data: unknown) =>
    res.write(`data: ${JSON.stringify({ event, ...(data as object) })}\n\n`)
  const log = (message: string) => send('log', { message })

  if (!inputA || !inputB) {
    send('error', { message: 'PR 두 개를 입력하세요 (예: owner/repo#1)' })
    return res.end()
  }

  const started = Date.now()
  const timeout = setTimeout(() => {
    send('error', { message: '5분을 넘겨서 중단했습니다.' })
    res.end()
  }, 300_000)

  let dispose: (() => Promise<void>) | null = null

  try {
    // ── 1. PR 수집 ──────────────────────────────────────────
    send('step', { index: 1, total: 5, label: 'PR 수집' })
    const refA = parsePr(inputA)
    const refB = parsePr(inputB)
    if (refA.repo !== refB.repo) throw new Error('두 PR이 같은 레포여야 합니다')

    const [prA, prB] = await Promise.all([
      fetchPr(refA.repo, refA.number),
      fetchPr(refB.repo, refB.number),
    ])
    log(`#${prA.number} ${prA.title} — ${prA.files.length}개 파일`)
    log(`#${prB.number} ${prB.title} — ${prB.files.length}개 파일`)

    const spec = await findSpec(refA.repo)
    log(spec ? `명세 발견: ${spec.path}` : '명세 문서 없음 — 기대값 근거가 약해집니다')
    send('prs', {
      repo: refA.repo,
      a: { number: prA.number, title: prA.title, files: prA.files },
      b: { number: prB.number, title: prB.title, files: prB.files },
      spec: spec?.path ?? null,
    })

    // ── 2. 미래 머지 ────────────────────────────────────────
    send('step', { index: 2, total: 5, label: '미래 머지' })
    const { collider, mergedCleanly } = await mergeFutures(refA.repo, prA, prB, log)
    dispose = collider.dispose
    send('merge', { cleanly: mergedCleanly })

    // ── 3. 기존 테스트 — Merge Queue가 보는 그림 ────────────
    send('step', { index: 3, total: 5, label: '기존 테스트' })
    const existing = await runExistingTests(collider, log)
    send('existing', { ...existing, output: existing.output.slice(-1500) })

    // ── 4. 가설 + 상호작용 테스트 생성 ──────────────────────
    send('step', { index: 4, total: 5, label: '상호작용 테스트 생성' })
    const specText = spec?.content ?? ''
    const cacheKey = [refA.repo, String(prA.number), String(prB.number), prA.diff, prB.diff]

    const { value: hypothesis, fromCache: hCached } = await generateWithCache(
      [...cacheKey, 'hypothesis'],
      () => hypothesize(prA, prB, specText, log),
      log,
    )
    send('hypothesis', { ...hypothesis, cached: hCached })

    const sample = await readSampleTest(collider)
    const sourceFiles = await listSourceFiles(collider)
    const { value: test, fromCache: tCached } = await generateWithCache(
      [...cacheKey, 'test'],
      () => writeInteractionTest(prA, prB, specText, hypothesis, sample, sourceFiles, log),
      log,
    )
    send('test', { path: test.path, content: test.content, cached: tCached })

    // ── 5. 증명 ─────────────────────────────────────────────
    send('step', { index: 5, total: 5, label: '충돌 증명' })
    const interaction = await runInteractionTest(collider, test, log)
    const assertion = extractAssertion(interaction.output)

    // 리포트 주소 발급 (DNSimple)
    let reportUrl: string | null = null
    try {
      const slug = makeSlug(`pr-${prA.number}-${prB.number}`)
      reportUrl = await publish(slug, `https://github.com/${refA.repo}`, log)
    } catch {
      log('리포트 주소 발급 건너뜀')
    }

    clearTimeout(timeout)
    send('done', {
      collided: interaction.failed > 0,
      existing,
      interaction: { ...interaction, output: interaction.output.slice(-2000) },
      assertion,
      hypothesis,
      reportUrl,
      elapsedMs: Date.now() - started,
    })
  } catch (err) {
    clearTimeout(timeout)
    console.error('[collider]', err)
    send('error', { message: friendly(err) })
  } finally {
    if (dispose) await dispose().catch(() => {})
    res.end()
  }
})

app.listen(PORT, () => {
  console.log(`\n  Collider → http://localhost:${PORT}`)
  try {
    console.log(`  분석 엔진: ${activeProvider().label}`)
  } catch (err) {
    console.log(`  ⚠️  ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!process.env.DAYTONA_API_KEY) console.log('  ⚠️  DAYTONA_API_KEY 없음')
  if (!process.env.DNSIMPLE_ZONE) console.log('  ℹ️  DNSIMPLE_ZONE 미설정 — 리포트 주소 생략')
  console.log()
})
