import { Script } from 'node:vm'
import { chat, type Log } from './generate.js'
import type { PullRequest } from './github.js'

export type Hypothesis = {
  /** 두 PR이 함께 건드리는 지점 */
  collisionPoint: string
  /** 왜 충돌할 수 있는지 */
  reasoning: string
  /** 명세가 말하는 기대 동작 */
  expected: string
}

export type InteractionTest = {
  path: string
  content: string
}

const TEST_PATH = 'test/_collider_interaction.test.ts'

/** diff 에 보이는 export 함수 이름. 테스트가 호출할 후보다. */
export function exportedFns(diff: string): string[] {
  return [...diff.matchAll(/export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!)
}

/** diff 의 추가 줄에서 그 PR이 들여온 식별자를 뽑는다. */
export function addedIdentifiers(diff: string): string[] {
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join(' ')
  const words = added.match(/[a-zA-Z_][a-zA-Z0-9_]{3,}/g) ?? []
  const noise = new Set(['import','export','from','const','return','function','describe','expect','test','true','false','null','undefined','number','string','order','price'])
  const freq = new Map<string, number>()
  for (const w of words) {
    if (noise.has(w.toLowerCase())) continue
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w)
}

/** it(...) 블록을 통째로 잘라낸다. 괄호 균형으로 끝을 찾는다. */
function splitCases(src: string): { head: string; cases: string[] } {
  const cases: string[] = []
  const re = /\b(it|test)\s*\(/g
  let m: RegExpExecArray | null
  let firstStart = -1

  while ((m = re.exec(src)) && cases.length < 50) {
    const start = m.index
    if (firstStart === -1) firstStart = start

    const open = src.indexOf('(', start)
    if (open === -1) break

    let depth = 0
    let i = open
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) break // 닫히지 않았다. 잘린 출력이다

    let end = i + 1
    if (src[end] === ';') end++

    cases.push(src.slice(start, end))
    // lastIndex 가 앞으로 가지 않으면 같은 자리를 무한히 다시 읽는다
    re.lastIndex = Math.max(end, start + 1)
  }
  return { head: firstStart === -1 ? src : src.slice(0, firstStart), cases }
}

/**
 * 두 PR의 기능을 모두 쓰는 테스트 하나만 남긴다.
 *
 * 모델은 기존 테스트를 베끼거나 관련 없는 케이스를 덧붙인다. 그러면 첫 실패가
 * 엉뚱한 테스트가 되어 충돌과 무관한 숫자가 보고된다. 골라내는 일은 추론이
 * 아니라 대조라서 모델에게 맡기지 않는다.
 */
export function keepInteractionCase(
  content: string,
  idsPerPr: string[][],
): { picked: string; dropped: number } | null {
  const { head, cases } = splitCases(content)
  if (cases.length === 0) return null

  // 모든 PR 의 식별자가 한 케이스 안에 다 나와야 상호작용이다
  const usesAll = (c: string) => idsPerPr.every((ids) => ids.some((x) => c.includes(x)))

  // 하나만 만들어 달라고 했고 하나만 왔으면 그대로 쓴다. 고를 것이 없다.
  if (cases.length === 1) return { picked: `${head.trimEnd()}\n  ${cases[0]!.trim()}\n})\n`, dropped: 0 }

  const hit = cases.filter(usesAll)
  if (hit.length === 0) return null

  // 여러 개면 가장 짧은 것. 군더더기 없는 쪽이 읽기 좋다.
  const best = hit.sort((a, b) => a.length - b.length)[0]!
  const body = `${head.trimEnd()}\n  ${best.trim()}\n})\n`
  return { picked: body, dropped: cases.length - 1 }
}

/**
 * 생성 테스트의 import 경로를 레포 실제 구조에 맞춰 다시 쓴다.
 *
 * 모델은 파일 이름은 맞게 고르지만 상대 경로를 자주 틀린다
 * (./orderService.js → ../src/orderService.js). 경로는 추론이 아니라
 * 조회로 풀 수 있는 문제라 모델에게 맡기지 않는다.
 */
export function fixImports(content: string, sourceFiles: string[]): { fixed: string; changed: string[] } {
  const changed: string[] = []
  const testDir = TEST_PATH.split('/').slice(0, -1).join('/')

  const fixed = content.replace(/from\s+['"](\.[^'"]+)['"]/g, (whole, spec: string) => {
    const base = spec.split('/').pop()!.replace(/\.(ts|js|mts|mjs)$/, '')
    const match = sourceFiles.find((f) => {
      const fb = f.split('/').pop()!.replace(/\.(ts|js)$/, '')
      return fb === base
    })
    if (!match) return whole

    // test/ 에서 대상 파일까지의 상대 경로
    const depth = testDir ? testDir.split('/').length : 0
    const rel = `${'../'.repeat(depth) || './'}${match.replace(/\.ts$/, '.js')}`
    if (rel === spec) return whole
    changed.push(`${spec} → ${rel}`)
    return `from '${rel}'`
  })

  return { fixed, changed }
}

/** diff에서 잡음(테스트 파일, 락파일)을 빼고 소스 변경만 남긴다. */
function sourceDiff(pr: PullRequest): string {
  return pr.diff
    .split(/^diff --git /m)
    .filter((chunk) => chunk.trim() && !/^a\/(.*\/)?(test|spec)s?\//.test(chunk))
    .map((c) => `diff --git ${c}`)
    .join('\n')
    .slice(0, 6000)
}

/**
 * 1단계 — AI가 가설을 세운다.
 *
 * 여기서 끝내지 않는다. 가설은 샌드박스 실행으로 증명/반증된다.
 */
export async function hypothesize(
  prs: PullRequest[],
  spec: string,
  onLog: Log,
): Promise<Hypothesis> {
  onLog(`PR ${prs.length}개의 충돌 가능성 분석 중...`)

  const blocks = prs
    .map((p) => `## PR #${p.number}: ${p.title}\n변경 파일: ${p.files.join(', ')}\n${sourceDiff(p)}`)
    .join('\n\n')

  const prompt = `Pull Request ${prs.length}개가 각각 독립적으로 테스트를 통과했습니다.
git 충돌도 없습니다. 하지만 함께 머지되면 동작이 명세와 달라질 수 있습니다.

## 명세 (기대 동작의 근거)
${spec.slice(0, 3000)}

${blocks}

## 할 일
변경들이 같은 계산 경로 위에 겹쳐 놓이는 지점을 찾으세요.
그리고 명세를 근거로 올바른 결과가 무엇인지 명시하세요.

아래 JSON만 출력하세요. 다른 말 금지.
{
  "collisionPoint": "겹치는 지점을 한 줄로 (예: quote() 안에서 두 할인이 연쇄 적용됨)",
  "reasoning": "왜 문제인지 2~3문장",
  "expected": "명세상 올바른 결과를 구체적 수치로"
}`

  const raw = await chat(prompt, onLog)
  // 추론형 모델은 <think> 블록이나 산문을 앞뒤에 붙인다.
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const h = JSON.parse(clean.slice(start, end + 1)) as Hypothesis
      if (h.collisionPoint) {
        onLog(`가설: ${h.collisionPoint}`)
        return h
      }
    } catch {
      // 아래 산문 폴백으로
    }
  }

  // JSON 이 아니어도 흐름을 죽이지 않는다. 가설은 설명이고, 증명은 실행이 한다.
  const text = clean.replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('모델이 빈 응답을 반환했습니다')
  onLog('가설이 JSON 형식은 아니지만 내용은 사용합니다')
  return {
    collisionPoint: text.slice(0, 160),
    reasoning: text.slice(0, 600),
    expected: '명세 문서 기준 (아래 생성 테스트 참조)',
  }
}

/**
 * 2단계 — 가설을 검증할 테스트를 만든다.
 *
 * 이게 Merge Queue와 갈라지는 지점이다.
 * Merge Queue는 **있는 테스트**를 돌린다. 없는 테스트는 못 만든다.
 */
export async function writeInteractionTest(
  prs: PullRequest[],
  spec: string,
  hypothesis: Hypothesis,
  sampleTest: string,
  sourceFiles: string[],
  onLog: Log,
): Promise<InteractionTest> {
  onLog('상호작용 시나리오 작성 중...')

  // 모델에게 테스트 파일을 통째로 쓰게 하면 import 경로, 호출 함수, 케이스 개수,
  // 사고 산문 혼입이 전부 변수가 된다. CI 에서 여섯 번 연속 파싱에 실패했다.
  // 모델은 입력과 기대값만 정하고, 파일은 여기서 만든다.
  const touchedFiles = [...new Set(prs.flatMap((p) => p.files))].filter(
    (f) => !/(test|spec)\./.test(f),
  )
  const entry = pickEntry(prs, touchedFiles, sourceFiles)
  const active = prs.map((p) => `- ${p.title} (${p.files.join(', ')})`).join('\n')

  const prompt = `## 명세
${spec.slice(0, 1200)}

## 이 저장소의 기존 테스트 (입력 형태 참고)
${sampleTest.split('\n').slice(0, 16).join('\n')}

## 상황
함수 ${entry.fn}() 를 호출한다. 지금 구현된 기능은 아래뿐이다.
${active}

위 목록에 있는 기능은 전부 이미 동작한다. 기대값은 그 기능을 모두 거친 최종 값이다.
목록에 없는 기능만 아직 코드에 없으므로 기대값에 넣지 말 것.

## 할 일
위 기능을 모두 함께 쓰는 입력 하나를 정하고, 명세가 말하는 계산식을 적어라.

**숫자로 답을 내지 마라.** 계산은 이쪽에서 한다. 너는 명세의 어느 규칙을
어떤 순서로 적용하는지만 식으로 적으면 된다.

expected 는 input 의 필드 이름과 숫자, 괄호, + - * / 만 써서 적는다.
evidence 에는 그 식의 근거가 되는 명세의 항목 이름을 적는다.

JSON 한 덩어리만 출력하라. 설명 금지. 아래는 형식 예시이며 값은 베끼지 말 것.

{"input":{"id":"a1","basePrice":20000,"someRate":0.8},"expected":"basePrice * someRate","evidence":"명세의 어느 항목"}`

  // 기대값은 모델이 명세를 읽고 직접 계산한 숫자다. 한 번만 물으면 산술이
  // 틀린 채로 통과해서 멀쩡한 조합이 충돌로 잡힌다. 실제로 모든 조합이
  // 충돌로 나온 적이 있다. 같은 질문을 여러 번 던져 같은 답이 두 번 나올
  // 때만 쓴다. 답이 흔들리면 충돌이라고 말하지 않고 판정을 보류한다.
  const votes: Scenario[] = []
  let lastErr = ''

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const s = parseScenario(await chat(prompt, onLog))
      votes.push(s)
      onLog(`${attempt}차 ${s.formula} = ${s.expected}${s.evidence ? ` (${s.evidence})` : ''}`)

      const agreed = votes.filter((v) => v.expected === s.expected)
      if (agreed.length >= 2) {
        onLog(`기대값 ${s.expected} 에 ${agreed.length}표. ${entry.fn}() 로 검사합니다`)
        return { path: TEST_PATH, content: renderTest(entry, s, prs) }
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      onLog(`${attempt}차 생성 실패: ${lastErr}. 다시 시도합니다`)
    }
  }

  if (votes.length === 0) throw new Error(`쓸 만한 시나리오를 얻지 못했습니다: ${lastErr}`)
  throw new Error(
    `기대값이 ${votes.map((v) => v.expected).join(', ')} 로 흔들려 판정을 보류합니다`,
  )
}

type Scenario = {
  input: Record<string, unknown>
  /** 모델이 적은 계산식. 숫자는 여기서 만들지 않는다. */
  formula: string
  expected: number
  evidence?: string
}

/**
 * 모델이 적은 계산식을 실제로 계산한다.
 *
 * 모델에게 숫자를 직접 물으면 산술을 틀린다. 명세의 어느 규칙을 어떤 순서로
 * 적용하는지는 모델이 잘 알아낸다. 규칙은 모델이 정하고 숫자는 코드가 만든다.
 *
 * 식에 들어올 수 있는 것을 입력 필드 이름과 사칙연산으로 제한한다. 모델이
 * 뱉은 문자열을 그대로 실행하는 자리라 넓게 열어 두면 무엇이든 돌아간다.
 */
export function evalFormula(formula: string, input: Record<string, unknown>): number {
  const expr = formula.trim()
  if (!/^[0-9a-zA-Z_+\-*/(). ]+$/.test(expr)) {
    throw new Error(`계산식에 허용되지 않은 문자가 있습니다: ${expr.slice(0, 60)}`)
  }

  const numeric = Object.entries(input).filter(([, v]) => typeof v === 'number') as [string, number][]
  const known = new Set(numeric.map(([k]) => k))

  for (const name of expr.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []) {
    if (!known.has(name)) throw new Error(`계산식이 입력에 없는 이름을 씁니다: ${name}`)
  }

  const fn = new Function(...numeric.map(([k]) => k), `return (${expr})`) as (
    ...args: number[]
  ) => unknown
  const value = fn(...numeric.map(([, v]) => v))
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`계산식이 숫자를 내지 않습니다: ${expr.slice(0, 60)}`)
  }

  // basePrice * (1 - 0.9) 같은 식은 부동소수 오차를 남긴다. 7999.999999999998 을
  // 기대값으로 쓰면 맞는 구현도 틀렸다고 나온다.
  const rounded = Math.round(value)
  return Math.abs(value - rounded) < 0.01 ? rounded : Number(value.toFixed(2))
}

/** 모델 출력에서 균형 잡힌 JSON 한 덩어리를 꺼낸다. 앞뒤 사고 산문은 버린다. */
export function parseScenario(raw: string): Scenario {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/g, '')

  // 사고 텍스트 안에도 중괄호가 섞여 나온다. 마지막에 나온 완결된 객체가 최종안이다.
  for (let start = cleaned.lastIndexOf('{'); start !== -1; start = cleaned.lastIndexOf('{', start - 1)) {
    let depth = 0
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++
      else if (cleaned[i] === '}' && --depth === 0) {
        try {
          const o = JSON.parse(cleaned.slice(start, i + 1)) as {
            input?: Record<string, unknown>
            expected?: unknown
            evidence?: string
          }
          if (o?.input && typeof o.expected === 'string' && o.expected.trim()) {
            // 프롬프트의 형식 예시를 그대로 베껴 오는 경우가 있다. 예시 값이
            // 그대로 돌아오면 모델이 명세를 읽지 않은 것이므로 버린다.
            if (/someRate/.test(o.expected)) throw new Error('형식 예시를 그대로 돌려줬습니다')
            return {
              input: o.input,
              formula: o.expected,
              expected: evalFormula(o.expected, o.input),
              evidence: o.evidence,
            }
          }

          // 식으로 적어 달라고 해도 숫자를 내놓을 때가 있다. 버리면 생성이
          // 자주 비므로 받되, 코드가 계산한 값이 아니므로 표를 한 번 더 받는다.
          if (o?.input && typeof o.expected === 'number' && Number.isFinite(o.expected)) {
            if (o.expected === 0) throw new Error('형식 예시를 그대로 돌려줬습니다')
            return {
              input: o.input,
              formula: `${o.expected} (모델이 직접 계산)`,
              expected: o.expected,
              evidence: o.evidence,
            }
          }
        } catch {
          /* 다음 후보로 */
        }
        break
      }
    }
  }
  throw new Error('input 과 계산식을 담은 JSON 을 찾지 못했습니다')
}

/**
 * 어느 함수를 호출할지는 모델이 아니라 여기서 정한다.
 *
 * 모델은 바깥 계층 대신 방금 바뀐 안쪽 함수를 부르곤 한다. 그러면 다른 PR 의
 * 기능이 실행되지 않아 상호작용을 검사하지 못한다. 다른 것을 부르는 쪽을 고른다.
 */
export function pickEntry(
  prs: PullRequest[],
  touched: string[],
  sourceFiles: string[],
): { fn: string; from: string } {
  const rank = (f: string) => (/invoice/i.test(f) ? 3 : /service/i.test(f) ? 2 : 1)

  const cands = prs.flatMap((p) => {
    const file = p.files.find((f) => !/(test|spec)\./.test(f))
    return file ? exportedFns(p.diff).map((fn) => ({ fn, from: file })) : []
  })

  if (cands.length === 0) {
    const from = [...touched, ...sourceFiles].sort((a, b) => rank(b) - rank(a))[0] ?? 'src/index.ts'
    return { fn: 'quote', from }
  }
  return cands.sort((a, b) => rank(b.from) - rank(a.from))[0]!
}

/** 값만 받아 테스트 파일을 만든다. 경로와 형식은 코드가 정하므로 흔들리지 않는다. */
function renderTest(entry: { fn: string; from: string }, s: Scenario, prs: PullRequest[]): string {
  const rel = `../${entry.from.replace(/\.tsx?$/, '.js')}`
  const names = prs.map((p) => `#${p.number}`).join(' + ')
  const why = `    // ${s.formula}${s.evidence ? ` — ${s.evidence.replace(/\s+/g, ' ').slice(0, 80)}` : ''}\n`

  return `import { describe, expect, it } from 'vitest'
import { ${entry.fn} } from '${rel}'

describe('${names} 상호작용', () => {
  it('두 변경을 함께 쓰면 명세대로 동작한다', () => {
${why}    expect(${entry.fn}(${JSON.stringify(s.input)})).toBe(${s.expected})
  })
})
`
}

/** 모델 출력에서 테스트 파일을 꺼내 검증한다. */
function buildTest(
  raw: string,
  prs: PullRequest[],
  sourceFiles: string[],
  onLog: Log,
): InteractionTest {
  let content = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // 추론형 모델은 "Thinking Process:" 같은 서문을 content 로 흘린다.
  // 코드가 실제로 시작하는 지점부터 잘라낸다.
  // 사고 텍스트 안에 코드펜스가 여러 개 있을 수 있다. 마지막 것이 최종안이다.
  const fences = [...content.matchAll(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/g)]
  const withTest = fences.filter((f) => /\b(it|test)\s*\(/.test(f[1] ?? ''))
  if (withTest.length) content = withTest[withTest.length - 1]![1]!.trim()
  else if (fences.length) content = fences[fences.length - 1]![1]!.trim()
  else {
    const codeStart = content.search(/^\s*(import |const |describe\(|it\(|test\()/m)
    if (codeStart > 0) content = content.slice(codeStart).trim()
  }
  content = content
    .replace(/^[\s\S]*?```(?:ts|typescript|js)?\s*/i, (m) => (m.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/, '')
    .trim()

  if (!/\b(it|test)\s*\(/.test(content)) {
    throw new Error('생성된 테스트에 테스트 케이스가 없습니다')
  }

  // 사고 산문이 그대로 흘러들어오면 테스트처럼 보여도 파싱되지 않는다.
  // import 구문 때문에 모듈로 감싸서 검사한다.
  try {
    new Script(`(async()=>{${content.replace(/^\s*import[^\n]*$/gm, '')}})`)
  } catch (err) {
    throw new Error(`생성된 테스트가 코드로 파싱되지 않습니다: ${(err as Error).message.slice(0, 80)}`)
  }

  // 두 PR 이 들여온 식별자로 상호작용 케이스를 골라낸다
  const idsPerPr = prs.map((p) => addedIdentifiers(p.diff))
  const only = keepInteractionCase(content, idsPerPr)
  if (!only) {
    throw new Error(`PR ${prs.length}개의 기능을 함께 쓰는 테스트가 생성되지 않았습니다`)
  }
  if (only.dropped > 0) onLog(`관련 없는 테스트 ${only.dropped}개 제거`)
  content = only.picked

  const { fixed, changed } = fixImports(content, sourceFiles)
  for (const c of changed) onLog(`import 경로 교정: ${c}`)

  onLog(`테스트 생성됨 (${fixed.split('\n').length}줄)`)
  return { path: TEST_PATH, content: fixed }
}
