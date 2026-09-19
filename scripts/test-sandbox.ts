/** npm run test:sandbox — 샌드박스에 HTML을 올리고 preview URL이 실제로 뜨는지 확인 */
import 'dotenv/config'
import { launchSandbox } from '../lib/sandbox.js'

const log = (m: string) => console.log('  ' + m)

const html = `<!doctype html><html lang="ko"><meta charset="utf-8">
<title>sandbox smoke test</title>
<body style="background:#0b0d10;color:#5eead4;font:20px system-ui;display:grid;place-items:center;height:100vh;margin:0">
hello world
</body></html>`

const { sandboxId, previewUrl } = await launchSandbox({ 'index.html': html }, log)

console.log(`\nsandbox: ${sandboxId}`)
console.log(`preview: ${previewUrl}\n`)

const res = await fetch(previewUrl)
const body = await res.text()

if (res.ok && body.includes('hello world')) {
  console.log(`✓ HTTP ${res.status} — "hello world" 확인. 브라우저로도 열어보세요:\n  ${previewUrl}`)
} else {
  console.error(`✗ HTTP ${res.status}\n${body.slice(0, 500)}`)
  process.exitCode = 1
}
