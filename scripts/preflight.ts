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
import { activeProvider } from '../lib/generate.js'
import { launchSandbox } from '../lib/sandbox.js'
import { ensureJsdom, verifyApp } from '../lib/verify.js'

type Check = { name: string; run: () => Promise<string> }

const env = (k: string) => process.env[k] || ''

const checks: Check[] = [
  {
    name: '생성 엔진 — 앱 HTML 생성',
    run: async () => {
      const provider = activeProvider()

      if (provider.kind === 'anthropic') {
        const res = await new Anthropic().messages.create({
          model: 'claude-opus-5',
          max_tokens: 16,
          output_config: { effort: 'low' },
          messages: [{ role: 'user', content: 'OK 한 단어만 출력' }],
        })
        return `${provider.label} · ${res.usage.output_tokens} 출력 토큰`
      }

      const base = env('LLM_ENDPOINT').replace(/\/$/, '')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env('LLM_API_KEY') ? { authorization: `Bearer ${env('LLM_API_KEY')}` } : {}),
        },
        body: JSON.stringify({
          model: env('LLM_MODEL'),
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Say OK.' }],
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = json.choices?.[0]?.message?.content
      if (!text) throw new Error('OpenAI 호환 응답이 아닙니다 — LLM_ENDPOINT 를 확인하세요')
      return `${provider.label} · "${text.trim().slice(0, 30)}"`
    },
  },
  {
    name: 'Daytona — 샌드박스 + preview URL + 검증기',
    run: async () => {
      if (!env('DAYTONA_API_KEY')) throw new Error('DAYTONA_API_KEY 미설정')
      const quiet = () => {}
      const t0 = Date.now()

      // 일부러 깨진 앱을 배포해서, 검증기가 실제로 잡아내는지 확인한다.
      const broken = `<!doctype html><html><head><title>broken</title></head>
<body><button id="b">click</button>
<script>document.getElementById('b').onclick = () => { alert('hi' }</script>
</body></html>`

      const { sandbox, previewUrl } = await launchSandbox({ 'index.html': broken }, quiet)
      const boot = Date.now() - t0

      await ensureJsdom(sandbox, quiet)
      const verdict = await verifyApp(sandbox, quiet)
      await new Daytona().delete(sandbox).catch(() => {})

      if (verdict.ok) throw new Error('검증기가 깨진 앱을 통과시켰습니다 — lib/verify.ts 확인 필요')
      return `부팅 ${(boot / 1000).toFixed(1)}s · preview OK · 검증기가 ${verdict.issues.length}건 적발 (${previewUrl.slice(0, 40)}…)`
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
