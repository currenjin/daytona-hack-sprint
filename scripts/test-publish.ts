/**
 * npm run test:publish -- [target-url]
 *
 * 라우터 등록 + DNSimple 레코드 생성 + 실제 접속까지 왕복 확인.
 * target을 안 주면 example.com 으로 붙여본다 (경로가 뚫렸는지만 보는 것).
 */
import 'dotenv/config'
import { publish } from '../lib/dns.js'
import { makeSlug } from '../lib/slug.js'

const target = process.argv[2] || 'https://example.com'
const slug = makeSlug('publish smoke test')
const log = (m: string) => console.log('  ' + m)

console.log(`slug:   ${slug}`)
console.log(`target: ${target}\n`)

const url = await publish(slug, target, log)
console.log(`\npublic: ${url}`)

const res = await fetch(url, { redirect: 'follow' })
if (res.ok) {
  console.log(`✓ HTTP ${res.status} — 도메인이 살아 있습니다.`)
} else {
  console.error(`✗ HTTP ${res.status}`)
  process.exitCode = 1
}
