import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PORT } from './lib/env.js'
import { activeProvider } from './lib/generate.js'
import { fetchPr, findSpec, parsePr } from './lib/github.js'
import { hypothesize, writeInteractionTest } from './lib/interaction.js'
import {
  clearGeneratedTest,
  extractAssertion,
  listSourceFiles,
  mergeCombination,
  openSandbox,
  readSampleTest,
  runExistingTests,
  runInteractionTest,
} from './lib/collide.js'
import { pickCombos } from './lib/combos.js'
import { nosanaCredits, shouldStop } from './lib/credits.js'
import { generateWithCache } from './lib/cache.js'

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
  const log = (message: string) => send('log', { message })

  if (inputs.length < 2) {
    send('error', { message: 'PR 을 두 개 이상 입력하세요 (예: owner/repo#1)' })
    return res.end()
  }

  const started = Date.now()
  let dispose: (() => Promise<void>) | null = null

  try {
    send('phase', { name: 'PR 수집' })
    const refs = inputs.map(parsePr)
    const repo = refs[0]!.repo
    if (refs.some((r) => r.repo !== repo)) throw new Error('PR 이 모두 같은 레포여야 합니다')

    const prs = await Promise.all(refs.map((r) => fetchPr(r.repo, r.number)))
    for (const p of prs) log(`#${p.number} ${p.title}`)

    const spec = await findSpec(repo)
    log(spec ? `명세 발견: ${spec.path}` : '명세 문서 없음. 기대값 근거가 약해집니다')

    const combos = pickCombos(prs)
    send('plan', {
      repo,
      prs: prs.map((p) => ({ number: p.number, title: p.title, files: p.files })),
      combos: combos.map((c) => c.label),
      spec: spec?.path ?? null,
    })
    log(`조합 ${combos.length}개를 검사합니다`)

    // 샌드박스는 하나만 띄우고 git reset 으로 되돌려 재사용한다
    send('phase', { name: '샌드박스 준비' })
    const { collider, baseRef } = await openSandbox(repo, log)
    dispose = collider.dispose

    const sample = await readSampleTest(collider)
    const sourceFiles = await listSourceFiles(collider)
    const specText = spec?.content ?? ''

    for (const [idx, combo] of combos.entries()) {
      send('combo:start', { index: idx, label: combo.label })

      const credits = await nosanaCredits()
      if (credits) send('credits', credits)
      if (shouldStop(credits)) {
        log('크레딧이 거의 없어 남은 조합을 건너뜁니다')
        send('combo:done', { index: idx, verdict: 'skipped', note: '크레딧 부족' })
        break
      }

      const merged = await mergeCombination(collider, baseRef, combo.prs, log)
      if (!merged.cleanly) {
        send('combo:done', { index: idx, verdict: 'conflict', note: 'git 충돌' })
        continue
      }

      const existing = await runExistingTests(collider, log)
      send('combo:existing', { index: idx, ...existing, output: existing.output.slice(-800) })

      if (!existing.passed) {
        send('combo:done', { index: idx, verdict: 'existing-fail', note: '기존 테스트 실패' })
        continue
      }

      // 기존 테스트가 통과할 때만 생성한다. 크레딧을 아끼는 자리다.
      // 한 조합의 생성이 실패해도 나머지 조합은 계속 검사한다.
      try {
        const cacheKey = [repo, ...combo.prs.map((p) => `${p.number}:${p.diff.length}`)]
        const hypothesis = (
          await generateWithCache([...cacheKey, 'h'], () => hypothesize(combo.prs, specText, log), log)
        ).value
        send('combo:hypothesis', { index: idx, ...hypothesis })

        const test = (
          await generateWithCache(
            [...cacheKey, 't'],
            () => writeInteractionTest(combo.prs, specText, hypothesis, sample, sourceFiles, log),
            log,
          )
        ).value
        send('combo:test', { index: idx, content: test.content })

        const interaction = await runInteractionTest(collider, test, log)
        const assertion = extractAssertion(interaction.output)
        await clearGeneratedTest(collider, test.path)

        send('combo:done', {
          index: idx,
          verdict: interaction.failed > 0 ? 'collision' : 'safe',
          assertion,
          output: interaction.output.slice(-1200),
        })
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        log(`${combo.label} 생성 실패: ${why}`)
        send('combo:done', { index: idx, verdict: 'error', note: why })
      }
    }

    send('done', { elapsedMs: Date.now() - started, credits: await nosanaCredits() })
  } catch (err) {
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
    console.log(`  ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!process.env.DAYTONA_API_KEY) console.log('  DAYTONA_API_KEY 없음')
  nosanaCredits().then((c) => {
    if (c) console.log(`  Nosana 크레딧 ${c.free.toFixed(2)} / ${c.assigned} (${c.level})`)
    console.log()
  })
})
