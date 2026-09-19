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
  a: PullRequest,
  b: PullRequest,
  spec: string,
  onLog: Log,
): Promise<Hypothesis> {
  onLog(`두 PR의 충돌 가능성 분석 중...`)

  const prompt = `두 개의 Pull Request가 각각 독립적으로 테스트를 통과했습니다.
git 충돌도 없습니다. 하지만 **함께 머지되면** 동작이 명세와 달라질 수 있습니다.

## 명세 (기대 동작의 근거)
${spec.slice(0, 3000)}

## PR #${a.number}: ${a.title}
변경 파일: ${a.files.join(', ')}
${sourceDiff(a)}

## PR #${b.number}: ${b.title}
변경 파일: ${b.files.join(', ')}
${sourceDiff(b)}

## 할 일
두 변경이 **같은 계산 경로 위에 겹쳐 놓이는 지점**을 찾으세요.
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
  a: PullRequest,
  b: PullRequest,
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

## PR #${a.number} 변경
${sourceDiff(a).slice(0, 2000)}

## PR #${b.number} 변경
${sourceDiff(b).slice(0, 2000)}

## 규칙
- **두 PR의 기능을 동시에 사용하는** 입력으로 테스트할 것. 하나만 쓰면 의미 없음.
- 기대값은 **명세에서 근거를 찾아** 구체적 숫자로 단언할 것.
- 기존 테스트와 같은 import 스타일·확장자를 쓸 것.
- 테스트 파일 전체 내용만 출력. 설명·코드펜스 금지.`

  const raw = await chat(prompt, onLog)
  let content = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // 추론형 모델은 "Thinking Process:" 같은 서문을 content 로 흘린다.
  // 코드가 실제로 시작하는 지점부터 잘라낸다.
  const fence = content.match(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/)
  if (fence) content = fence[1]!.trim()
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

  const { fixed, changed } = fixImports(content, sourceFiles)
  for (const c of changed) onLog(`import 경로 교정: ${c}`)

  onLog(`테스트 생성됨 (${fixed.split('\n').length}줄)`)
  return { path: TEST_PATH, content: fixed }
}
