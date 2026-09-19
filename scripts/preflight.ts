/**
 * 스폰서 3개 자격증명을 한 번에 검증한다.
 *   npm run preflight
 */
import 'dotenv/config'
import { daytona as newDaytona } from '../lib/daytona.js'
import { stripAnsi } from '../lib/collide.js'
import { fetchPr, findSpec } from '../lib/github.js'

const env = (k: string) => process.env[k] || ''
type Check = { name: string; run: () => Promise<string> }

const checks: Check[] = [
  {
    name: 'GitHub — PR 수집 (gh CLI)',
    run: async () => {
      const pr = await fetchPr('currenjin/collider-demo', 1)
      const spec = await findSpec('currenjin/collider-demo')
      return `#${pr.number} "${pr.title}" · diff ${pr.diff.length}자 · 명세 ${spec?.path ?? '없음'}`
    },
  },
  {
    name: 'Daytona — 샌드박스 + 클론 + npm install 속도',
    run: async () => {
      if (!env('DAYTONA_API_KEY')) throw new Error('DAYTONA_API_KEY 미설정')
      const daytona = newDaytona()
      const t0 = Date.now()
      const sandbox = await daytona.create(
        {
          language: 'typescript',
          public: true,
          autoStopInterval: 15,
          ...(env('DAYTONA_SNAPSHOT') ? { snapshot: env('DAYTONA_SNAPSHOT') } : {}),
        },
        { timeout: 180 },
      )
      const boot = Date.now() - t0

      const t1 = Date.now()
      const clone = await sandbox.process.executeCommand(
        'rm -rf /tmp/r && git clone --quiet https://github.com/currenjin/collider-demo.git /tmp/r && echo ok',
      )
      if (clone.exitCode !== 0) throw new Error(`클론 실패: ${String(clone.result).slice(0, 200)}`)
      const cloneMs = Date.now() - t1

      const t2 = Date.now()
      const inst = await sandbox.process.executeCommand(
        'cd /tmp/r && npm install --silent --no-audit --no-fund 2>&1 | tail -2 && npm test 2>&1 | tail -4',
      )
      const testMs = Date.now() - t2
      const out = stripAnsi(String(inst.result ?? ''))

      await daytona.delete(sandbox).catch(() => {})

      const total = (boot + cloneMs + testMs) / 1000
      const passed = /Tests\s+\d+\s+passed/.test(out)
      if (!passed) throw new Error(`테스트가 안 돌았습니다: ${out.slice(-200)}`)
      return `부팅 ${(boot / 1000).toFixed(1)}s + 클론 ${(cloneMs / 1000).toFixed(1)}s + install·test ${(testMs / 1000).toFixed(1)}s = ${total.toFixed(1)}s`
    },
  },
  {
    name: 'Nosana — 생성 엔진 (OpenAI 호환)',
    run: async () => {
      const base = env('LLM_ENDPOINT').replace(/\/$/, '')
      if (!base || !env('LLM_MODEL')) {
        if (env('ANTHROPIC_API_KEY')) return 'Anthropic 폴백 사용 중 (Nosana 미설정)'
        throw new Error('LLM_ENDPOINT + LLM_MODEL 미설정')
      }
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env('LLM_API_KEY') ? { authorization: `Bearer ${env('LLM_API_KEY')}` } : {}),
        },
        body: JSON.stringify({
          model: env('LLM_MODEL'),
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = j.choices?.[0]?.message?.content
      if (!text) throw new Error('OpenAI 호환 응답이 아닙니다 — lib/generate.ts 파싱을 고쳐야 합니다')
      return `${env('LLM_MODEL')} · "${text.trim().slice(0, 30)}"`
    },
  },
  {
    name: 'DNSimple — 토큰 + account ID',
    run: async () => {
      if (!env('DNSIMPLE_TOKEN')) throw new Error('DNSIMPLE_TOKEN 미설정')
      const res = await fetch('https://api.dnsimple.com/v2/whoami', {
        headers: { authorization: `Bearer ${env('DNSIMPLE_TOKEN')}`, accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as { data?: { account?: { id?: number } } }
      const id = j.data?.account?.id
      if (!id) throw new Error('account.id 없음 — User token 말고 Account token 을 쓰세요')
      const set = env('DNSIMPLE_ACCOUNT_ID')
      if (set && String(id) !== set) throw new Error(`.env(${set}) 와 실제(${id}) 불일치`)
      return `account ${id}${set ? '' : `  ← .env 의 DNSIMPLE_ACCOUNT_ID 에 ${id} 를 넣으세요`}`
    },
  },
]

const results: { name: string; ok: boolean; detail: string }[] = []
for (const c of checks) {
  process.stdout.write(`… ${c.name}\n`)
  try {
    const detail = await c.run()
    results.push({ name: c.name, ok: true, detail })
    console.log(`  ✓ ${detail}\n`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    results.push({ name: c.name, ok: false, detail })
    console.log(`  ✗ ${detail}\n`)
  }
}

const failed = results.filter((r) => !r.ok)
console.log('─'.repeat(64))
console.log(`${results.length - failed.length}/${results.length} 통과`)
if (failed.length) {
  console.log('\n막힌 것:')
  for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`)
  process.exitCode = 1
}
