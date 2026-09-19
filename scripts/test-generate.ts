/** npm run test:generate -- "홍대 라멘집 리뷰 사이트" — HTML 생성만 검증 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTitle, generateApp } from '../lib/generate.js'

const prompt = process.argv.slice(2).join(' ') || '홍대 라멘집 리뷰 사이트'
const log = (m: string) => console.log('  ' + m)

console.log(`프롬프트: ${prompt}\n`)

const t0 = Date.now()
const files = await generateApp(prompt, log)
const html = files['index.html']!

const out = join(tmpdir(), `ship-${Date.now()}.html`)
writeFileSync(out, html, 'utf8')

console.log(`\n✓ ${((Date.now() - t0) / 1000).toFixed(1)}s · ${(html.length / 1024).toFixed(1)}KB`)
console.log(`  title: ${extractTitle(html)}`)
console.log(`  저장: ${out}`)
console.log(`\n브라우저로 열어서 확인하세요:\n  open ${out}`)
