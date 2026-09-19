import { Daytona, type Sandbox } from '@daytona/sdk'
import type { Log } from './generate.js'
import type { PullRequest } from './github.js'
import type { InteractionTest } from './interaction.js'

const WORK = '/tmp/repo'

export type TestRun = {
  passed: boolean
  total: number
  failed: number
  output: string
}

async function run(sandbox: Sandbox, cmd: string) {
  return sandbox.process.executeCommand(`cd ${WORK} && ${cmd}`)
}

/** vitest / jest 출력에서 통과·실패 수를 뽑는다. */
function parseTestOutput(output: string): Omit<TestRun, 'output'> {
  const m = output.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i)
  if (m) {
    const failed = Number(m[1] ?? 0)
    const passed = Number(m[2] ?? 0)
    return { passed: failed === 0, total: failed + passed, failed }
  }
  // 실패 수만 나오는 경우
  const f = output.match(/Tests\s+(\d+)\s+failed/i)
  if (f) return { passed: false, total: Number(f[1]), failed: Number(f[1]) }
  return { passed: !/FAIL|failed/i.test(output), total: 0, failed: 0 }
}

export type Collider = {
  sandbox: Sandbox
  /** 정리용 */
  dispose: () => Promise<void>
}

/** 샌드박스를 띄우고 레포를 클론한 뒤 두 PR을 머지한다. */
export async function mergeFutures(
  repo: string,
  a: PullRequest,
  b: PullRequest,
  onLog: Log,
): Promise<{ collider: Collider; mergedCleanly: boolean }> {
  const daytona = new Daytona()

  onLog('Daytona 샌드박스 부팅...')
  const sandbox = await daytona.create(
    {
      language: 'typescript',
      public: true,
      autoStopInterval: 30,
      ...(process.env.DAYTONA_SNAPSHOT ? { snapshot: process.env.DAYTONA_SNAPSHOT } : {}),
    },
    { timeout: 180 },
  )
  onLog(`샌드박스 준비 (${sandbox.id})`)

  const dispose = async () => {
    await daytona.delete(sandbox).catch(() => {})
  }

  onLog(`${repo} 클론 중...`)
  const clone = await sandbox.process.executeCommand(
    `rm -rf ${WORK} && git clone --quiet https://github.com/${repo}.git ${WORK} && cd ${WORK} && git config user.email c@c.dev && git config user.name collider && echo ok`,
  )
  if (clone.exitCode !== 0) {
    await dispose()
    throw new Error(`클론 실패: ${String(clone.result).slice(0, 300)}`)
  }

  onLog(`PR #${a.number} 머지...`)
  const mA = await run(sandbox, `git fetch --quiet origin ${a.headRef} && git merge --no-edit FETCH_HEAD`)
  onLog(`PR #${b.number} 머지...`)
  const mB = await run(sandbox, `git fetch --quiet origin ${b.headRef} && git merge --no-edit FETCH_HEAD`)

  const mergedCleanly = mA.exitCode === 0 && mB.exitCode === 0
  if (!mergedCleanly) {
    onLog('git 충돌 발생 — 텍스트 충돌은 기존 도구도 잡습니다')
  } else {
    onLog('git 충돌 없음 ✓')
  }

  onLog('의존성 설치...')
  await run(sandbox, 'npm install --silent --no-audit --no-fund 2>&1 | tail -2')

  return { collider: { sandbox, dispose }, mergedCleanly }
}

/** 레포에 이미 있는 테스트를 돌린다. Merge Queue가 보는 그림. */
export async function runExistingTests(c: Collider, onLog: Log): Promise<TestRun> {
  onLog('기존 테스트 실행...')
  const res = await run(c.sandbox, 'npm test 2>&1 | tail -40')
  const output = String(res.result ?? '')
  const parsed = parseTestOutput(output)
  onLog(
    parsed.passed
      ? `기존 테스트 ${parsed.total}개 전부 통과 ✓  ← Merge Queue도 여기서 통과시킵니다`
      : `기존 테스트 ${parsed.failed}/${parsed.total} 실패`,
  )
  return { ...parsed, output }
}

/** 기존 테스트 파일 하나를 샘플로 읽는다 (생성 테스트의 형식 참고용). */
export async function readSampleTest(c: Collider): Promise<string> {
  const res = await run(
    c.sandbox,
    `find . -path ./node_modules -prune -o \\( -name '*.test.*' -o -name '*.spec.*' \\) -print | head -1 | xargs cat 2>/dev/null || true`,
  )
  return String(res.result ?? '')
}

/** 생성한 상호작용 테스트를 넣고 다시 돌린다. 여기가 갈라지는 지점. */
export async function runInteractionTest(
  c: Collider,
  test: InteractionTest,
  onLog: Log,
): Promise<TestRun> {
  const b64 = Buffer.from(test.content, 'utf8').toString('base64')
  await run(c.sandbox, `mkdir -p "$(dirname '${test.path}')" && echo '${b64}' | base64 -d > '${test.path}'`)

  onLog('상호작용 테스트 실행...')
  const res = await run(c.sandbox, `npm test 2>&1 | tail -60`)
  const output = String(res.result ?? '')
  const parsed = parseTestOutput(output)

  onLog(
    parsed.failed > 0
      ? `상호작용 테스트 실패 — 충돌 증명됨 ✗`
      : `상호작용 테스트 통과 — 이 조합은 안전합니다 ✓`,
  )
  return { ...parsed, output }
}

/** 실패 출력에서 기대값·실제값을 뽑는다. 데모의 숫자. */
export function extractAssertion(output: string): { expected?: string; actual?: string } {
  const m = output.match(/expected\s+(.+?)\s+to\s+(?:be|equal)\s+(.+?)(?:\s*\/\/|$)/im)
  if (m) return { actual: m[1]?.trim(), expected: m[2]?.trim() }
  return {}
}
