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
  onLog('상호작용 테스트 작성 중...')

  const prompt = `두 PR이 함께 머지됐을 때의 상호작용을 검증하는 테스트를 작성하세요.

## 충돌 가설
겹치는 지점: ${hypothesis.collisionPoint}
이유: ${hypothesis.reasoning}
명세상 기대: ${hypothesis.expected}

## 명세
${spec.slice(0, 2500)}

## 이 레포의 기존 테스트 (형식과 import 경로를 그대로 따를 것)
${sampleTest.slice(0, 1500)}

${prs.map((p) => `## PR #${p.number} 변경\n${sourceDiff(p).slice(0, Math.floor(4500 / prs.length))}`).join('\n\n')}

## 규칙
- **테스트 케이스는 정확히 하나만 작성한다.** it() 이 두 개 이상이면 안 된다.
- 그 하나는 **PR ${prs.length}개의 기능을 동시에 사용하는** 입력을 쓴다. 일부만 쓰면 의미가 없다.
- **기존 테스트를 옮겨 적지 않는다.** 이미 레포에 있다.
- 기대값은 명세에서 **이 조합에 해당하는 계산만** 골라 직접 계산해 숫자로 단언한다.
- ⚠️ **위에 나열된 PR 의 기능만 존재한다.** 명세에 적혀 있어도 이 조합에 없는 기능(다른 PR 이 구현할 것)은 적용하지 않는다. 그 기능을 쓰는 함수는 아직 아무 일도 하지 않는다.
- 타입 단언(as X)을 쓰지 않는다. 타입을 import 하지 않았으므로 깨진다.
- 기존 테스트와 같은 import 스타일과 확장자를 쓴다.
- 테스트 파일 전체 내용만 출력한다. 설명과 코드펜스는 쓰지 않는다.`

  const raw = await chat(prompt, onLog)
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
