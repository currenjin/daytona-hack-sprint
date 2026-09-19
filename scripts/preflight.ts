/**
 * 전날 밤에 딱 한 번 돌리는 검증 스크립트.
 * 여기가 전부 초록이면 당일 데모에서 새로 터질 게 거의 없다.
 *
 *   npm run preflight
 */
import 'dotenv/config'
import { promises as dns } from 'node:dns'
import Anthropic from '@anthropic-ai/sdk'
import { Daytona } from '@daytona/sdk'

type Check = { name: string; run: () => Promise<string> }

const env = (k: string) => process.env[k] || ''

const checks: Check[] = [
  {
    name: 'Anthropic — 앱 생성 모델',
    run: async () => {
      if (!env('ANTHROPIC_API_KEY')) throw new Error('ANTHROPIC_API_KEY 미설정')
      const res = await new Anthropic().messages.create({
        model: 'claude-opus-5',
        max_tokens: 16,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'OK 한 단어만 출력' }],
      })
      return `응답 OK (${res.usage.output_tokens} 출력 토큰)`
    },
  },
  {
    name: 'Daytona — 샌드박스 + preview URL',
    run: async () => {
      if (!env('DAYTONA_API_KEY')) throw new Error('DAYTONA_API_KEY 미설정')
      const t0 = Date.now()
      const daytona = new Daytona()
      const sandbox = await daytona.create(
        { language: 'typescript', public: true, autoStopInterval: 15 },
        { timeout: 180 },
      )
      const boot = Date.now() - t0
      const link = await sandbox.getPreviewLink(3000)
      await daytona.delete(sandbox).catch(() => {})
      return `부팅 ${(boot / 1000).toFixed(1)}s · preview ${link.url}`
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
      const json = (await res.json()) as { data?: { account?: { id?: number } } }
      const id = json.data?.account?.id
      if (!id) throw new Error('account.id 없음 — User token 대신 Account token을 쓰세요')
      const configured = env('DNSIMPLE_ACCOUNT_ID')
      if (configured && String(id) !== configured) {
        throw new Error(`.env의 DNSIMPLE_ACCOUNT_ID(${configured}) 와 실제(${id}) 불일치`)
      }
      return `account ${id}${configured ? '' : ' ← .env의 DNSIMPLE_ACCOUNT_ID 에 넣으세요'}`
    },
  },
  {
    name: 'DNS — 와일드카드 레코드 전파',
    run: async () => {
      const zone = env('DNSIMPLE_ZONE')
      if (!zone) throw new Error('DNSIMPLE_ZONE 미설정')
      const host = `preflight-${Date.now()}.ship.${zone}`
      const addrs = await dns.resolve4(host)
      const expected = env('VPS_IP')
      if (expected && !addrs.includes(expected)) {
        throw new Error(`${host} → ${addrs.join(', ')} (기대: ${expected})`)
      }
      return `${host} → ${addrs.join(', ')}`
    },
  },
  {
    name: 'Caddy/라우터 — 와일드카드 TLS',
    run: async () => {
      const routerUrl = env('ROUTER_URL')
      if (!routerUrl) throw new Error('ROUTER_URL 미설정')
      const res = await fetch(`${routerUrl.replace(/\/$/, '')}/_routes`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const routes = (await res.json()) as Record<string, string>
      return `TLS 통과 · 등록된 라우트 ${Object.keys(routes).length}개`
    },
  },
  {
    name: 'Nosana — 오픈모델 추론',
    run: async () => {
      const endpoint = env('NOSANA_ENDPOINT')
      const model = env('NOSANA_MODEL')
      if (!endpoint || !model) throw new Error('NOSANA_ENDPOINT / NOSANA_MODEL 미설정')
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env('NOSANA_API_KEY') ? { authorization: `Bearer ${env('NOSANA_API_KEY')}` } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Say OK.' }],
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = json.choices?.[0]?.message?.content
      if (!text) throw new Error('OpenAI 호환 응답이 아닙니다 — lib/nosana.ts 의 파싱을 고치세요')
      return `응답: ${text.trim().slice(0, 40)}`
    },
  },
]

const results: { name: string; ok: boolean; detail: string }[] = []

for (const check of checks) {
  process.stdout.write(`… ${check.name}\n`)
  try {
    const detail = await check.run()
    results.push({ name: check.name, ok: true, detail })
    console.log(`  ✓ ${detail}\n`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    results.push({ name: check.name, ok: false, detail })
    console.log(`  ✗ ${detail}\n`)
  }
}

const failed = results.filter((r) => !r.ok)
console.log('─'.repeat(60))
console.log(`${results.length - failed.length}/${results.length} 통과`)
if (failed.length) {
  console.log('\n오늘 밤 안에 고쳐야 할 것:')
  for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`)
  process.exitCode = 1
} else {
  console.log('전부 통과. 내일 14:00에 코드만 짜면 됩니다.')
}
