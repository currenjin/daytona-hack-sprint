import 'dotenv/config'
import { fetchPr, parsePr } from '../lib/github.js'
import { mergeFutures, runExistingTests, runInteractionTest, extractAssertion } from '../lib/collide.js'

const log = (m: string) => console.log('  ' + m)
const a = parsePr('currenjin/collider-demo#1')
const b = parsePr('currenjin/collider-demo#2')
const [prA, prB] = await Promise.all([fetchPr(a.repo, a.number), fetchPr(b.repo, b.number)])

const { collider } = await mergeFutures(a.repo, prA, prB, log)
const existing = await runExistingTests(collider, log)

// Nosana 가 만들어야 할 것을 손으로 써서 파이프라인만 먼저 검증한다
const handWritten = `import { describe, expect, it } from 'vitest'
import { quote } from '../src/orderService.js'

describe('쿠폰 + 멤버십 동시 적용', () => {
  it('두 할인 모두 기본 운임 기준으로 계산해 합산 차감한다', () => {
    // SPEC.md: 10,000 - 1,000(쿠폰) - 1,000(멤버십 10%) = 8,000
    expect(quote({ id: 'x', basePrice: 10000, couponAmount: 1000, membershipRate: 0.9 })).toBe(8000)
  })
})`

const interaction = await runInteractionTest(
  collider,
  { path: 'test/_collider_interaction.test.ts', content: handWritten },
  log,
)
const assertion = extractAssertion(interaction.output)

console.log(`\n${'─'.repeat(62)}`)
console.log(`기존 테스트        : ${existing.passed ? '✓ 전부 통과' : '✗'} (${existing.total}개)`)
console.log(`상호작용 테스트    : ${interaction.failed > 0 ? '✗ 실패 — 충돌 증명' : '✓ 통과'}`)
console.log(`기대값 추출        : ${assertion.expected ?? '(실패)'}`)
console.log(`실제값 추출        : ${assertion.actual ?? '(실패)'}`)
console.log(`\n→ 데모 클라이맥스 숫자: 기대 ${assertion.expected} / 실제 ${assertion.actual}`)
await collider.dispose()
