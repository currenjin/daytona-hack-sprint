import 'dotenv/config'
import { fetchPr, findSpec, parsePr } from '../lib/github.js'
import { mergeFutures, runExistingTests, readSampleTest } from '../lib/collide.js'

const log = (m: string) => console.log('  ' + m)
const a = parsePr('currenjin/collider-demo#1')
const b = parsePr('currenjin/collider-demo#2')

const [prA, prB] = await Promise.all([fetchPr(a.repo, a.number), fetchPr(b.repo, b.number)])
console.log(`\n[1] PR 수집`); log(`#${prA.number} ${prA.title}`); log(`#${prB.number} ${prB.title}`)
const spec = await findSpec(a.repo); log(`명세: ${spec?.path}`)

console.log(`\n[2] 미래 머지`)
const t0 = Date.now()
const { collider, mergedCleanly } = await mergeFutures(a.repo, prA, prB, log)

console.log(`\n[3] 기존 테스트`)
const existing = await runExistingTests(collider, log)
const sample = await readSampleTest(collider)

console.log(`\n${'─'.repeat(60)}`)
console.log(`git 충돌 없음        : ${mergedCleanly ? '✓' : '✗'}`)
console.log(`기존 테스트 통과      : ${existing.passed ? '✓' : '✗'}  (${existing.total}개)`)
console.log(`샘플 테스트 읽기      : ${sample.length > 0 ? '✓ ' + sample.length + '자' : '✗'}`)
console.log(`소요                 : ${((Date.now()-t0)/1000).toFixed(1)}s`)
console.log(`\n→ 데모 전반부 성립 조건: 충돌없음 ✓ + 기존테스트 전부초록 ✓`)
await collider.dispose()
