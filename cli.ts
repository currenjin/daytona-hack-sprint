import { fetchPr, listOpenPrs, upsertComment } from './lib/github.js'
import { runCollisionAnalysis, type CollisionReport } from './lib/engine.js'
import { pairsWith } from './lib/combos.js'
import { optional } from './lib/env.js'
import { COLLIDER_MARKER, renderCommentBody, renderErrorCommentBody } from './lib/comment.js'
import type { PrReport } from './lib/svg.js'

/**
 * GitHub Actions 에서 도는 진입점.
 *
 * 웹에서는 사람이 PR 번호를 직접 넣지만, CI 는 방금 바뀐 PR 하나만 안다.
 * 나머지 open PR 을 조회해서 짝만 검사한다. 저장소 전체 조합을 볼 이유가 없다.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function fail(message: string): never {
  console.error(`collider: ${message}`)
  process.exit(2)
}

const repo = arg('repo') ?? optional('GITHUB_REPOSITORY')
const prArg = arg('pr')
if (!repo) fail('--repo owner/name 이 필요합니다')
if (!prArg) fail('--pr <번호> 가 필요합니다')
const current = Number(prArg)
if (!Number.isInteger(current)) fail(`PR 번호가 숫자가 아닙니다: ${prArg}`)

const baseUrl = optional('PUBLIC_BASE_URL').replace(/\/$/, '')

/** 엔진 결과를 PR 코멘트가 쓰는 모양으로 줄인다. */
function toPrReport(r: CollisionReport, currentPr: { number: number; title: string }): PrReport {
  const titleOf = (n: number) => r.prs.find((p) => p.number === n)?.title

  // 충돌이 여러 개여도 코멘트에는 하나만 보여 준다. 읽는 사람이 먼저 할 일은
  // 하나를 확인하는 것이지 목록을 훑는 것이 아니다.
  const first = r.collisions[0]
  const other = first?.prs.find((n) => n !== currentPr.number)

  const existing = r.combinations.find((c) => c.existing)?.existing

  return {
    repo: r.repo,
    currentPr: { number: currentPr.number, title: currentPr.title },
    checkedPrs: r.combinations
      .filter((c) => c.verdict === 'collision' || c.verdict === 'safe')
      .map((c) => {
        const n = c.prs.find((x) => x !== currentPr.number)!
        return { number: n, title: titleOf(n) }
      }),
    existingTests: existing ? { passed: existing.total - existing.failed, total: existing.total } : undefined,
    collision:
      first && other !== undefined
        ? {
            withPr: other,
            withPrTitle: titleOf(other),
            impact: first.hypothesis?.collisionPoint,
            expected: first.assertion?.expected,
            actual: first.assertion?.actual,
          }
        : undefined,
  }
}

/** 서버에 결과를 올려 코멘트에 넣을 URL 을 받는다. 서버가 없으면 조용히 건너뛴다. */
async function publish(report: PrReport): Promise<{ svgUrl?: string; reportUrl?: string }> {
  if (!baseUrl) return {}
  try {
    const res = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { id } = (await res.json()) as { id: string }
    return { svgUrl: `${baseUrl}/reports/${id}.svg`, reportUrl: `${baseUrl}/reports/${id}` }
  } catch (err) {
    console.warn(`collider: 리포트 업로드 실패, 코멘트는 텍스트로 남깁니다 (${String(err)})`)
    return {}
  }
}

async function comment(body: string): Promise<void> {
  try {
    await upsertComment(repo!, current, COLLIDER_MARKER, body)
    console.log('collider: PR 코멘트를 남겼습니다')
  } catch (err) {
    console.error(`collider: 코멘트 실패 ${String(err)}`)
  }
}

async function main(): Promise<number> {
  console.log(`collider: ${repo} #${current}`)

  const open = await listOpenPrs(repo!)
  const others = open.filter((p) => p.number !== current)
  if (others.length === 0) {
    console.log('collider: 함께 검사할 다른 open PR 이 없습니다')
    await comment(
      `${COLLIDER_MARKER}\n### Collider\n\nNo other open pull requests to check against.`,
    )
    return 0
  }

  const currentPr = await fetchPr(repo!, current)
  const otherPrs = await Promise.all(others.map((p) => fetchPr(repo!, p.number)))
  console.log(`collider: ${others.map((p) => `#${p.number}`).join(', ')} 와 짝지어 검사합니다`)

  const result = await runCollisionAnalysis({
    repo: repo!,
    prs: [currentPr, ...otherPrs],
    combos: (prs) => pairsWith(prs[0]!, prs.slice(1)),
    onEvent: (e) => {
      if (e.event === 'log') console.log(`  ${e.message}`)
      if (e.event === 'combo:done') console.log(`  ${e.index} → ${String(e.verdict)}`)
    },
  })

  // Daytona, Nosana, 테스트 생성 문제를 충돌로 표시하지 않는다.
  // 인프라가 흔들렸다는 이유로 멀쩡한 PR 을 막으면 아무도 이 검사를 켜두지 않는다.
  const unusable = result.checkError || result.checkedCount === 0
  if (unusable) {
    const reason =
      result.checkError ??
      result.combinations.find((c) => c.note)?.note ??
      '검사한 조합이 없습니다'
    console.error(`collider: CHECK_ERROR ${reason}`)
    await comment(renderErrorCommentBody(repo!, reason))
    return 0
  }

  const report = toPrReport(result, { number: currentPr.number, title: currentPr.title })
  const urls = await publish(report)
  await comment(renderCommentBody(report, urls))

  if (result.collisionCount > 0) {
    console.error(
      `collider: ${result.collisionCount}개 조합에서 충돌을 찾았습니다 (검사 ${result.checkedCount})`,
    )
    return 1
  }
  console.log(`collider: 충돌 없음 (검사 ${result.checkedCount})`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // 여기까지 온 것은 분석 이전 단계가 깨진 경우다. 역시 충돌이 아니다.
    console.error(`collider: CHECK_ERROR ${err instanceof Error ? err.message : String(err)}`)
    process.exit(0)
  })
