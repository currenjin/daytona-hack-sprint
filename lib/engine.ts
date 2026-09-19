import { fetchPr, findSpec, type PullRequest } from './github.js'
import { hypothesize, writeInteractionTest, type Hypothesis } from './interaction.js'
import {
  clearGeneratedTest,
  extractAssertion,
  listSourceFiles,
  mergeCombination,
  openSandbox,
  readSampleTest,
  runExistingTests,
  runInteractionTest,
} from './collide.js'
import { pickCombos, type Combo } from './combos.js'
import { nosanaCredits, shouldStop } from './credits.js'
import { generateWithCache } from './cache.js'

/**
 * 충돌과 오류를 구분한다.
 *
 * Daytona 가 안 뜨거나 Nosana 가 답을 못 주는 것은 PR 의 잘못이 아니다.
 * 이것을 collision 으로 표시하면 멀쩡한 PR 이 막힌다.
 */
export type Verdict =
  | 'collision'
  | 'safe'
  | 'conflict'
  | 'existing-fail'
  | 'error'
  | 'skipped'

export type PullRequestSummary = {
  number: number
  title: string
  files: string[]
}

export type CombinationResult = {
  index: number
  label: string
  prs: number[]
  verdict: Verdict
  existing?: { passed: boolean; total: number; failed: number }
  hypothesis?: Hypothesis
  test?: string
  assertion?: { expected?: string; actual?: string }
  output?: string
  note?: string
}

export type CollisionReport = {
  repo: string
  prs: PullRequestSummary[]
  spec: string | null
  combinations: CombinationResult[]
  collisions: CombinationResult[]
  checkedCount: number
  collisionCount: number
  elapsedMs: number
  /** 분석 자체가 끝나지 못한 경우. collision 과 절대 섞지 않는다. */
  checkError?: string
}

export type EngineEvent =
  | { event: 'phase'; name: string }
  | { event: 'log'; message: string }
  | { event: 'plan'; repo: string; prs: PullRequestSummary[]; combos: string[]; spec: string | null }
  | { event: 'combo:start'; index: number; label: string }
  | { event: 'credits'; [k: string]: unknown }
  | { event: 'combo:existing'; index: number; [k: string]: unknown }
  | { event: 'combo:hypothesis'; index: number; [k: string]: unknown }
  | { event: 'combo:test'; index: number; content: string }
  | { event: 'combo:done'; index: number; [k: string]: unknown }
  | { event: 'done'; [k: string]: unknown }
  | { event: 'error'; message: string }

export type OnEvent = (e: EngineEvent) => void

export type AnalysisInput = {
  repo: string
  /** 이미 가져온 PR 들. 없으면 numbers 로 가져온다. */
  prs?: PullRequest[]
  numbers?: number[]
  /** 검사할 조합을 직접 고른다. 비우면 pairwise + 전체. */
  combos?: (prs: PullRequest[]) => Combo[]
  onEvent?: OnEvent
}

/**
 * 웹과 CI 가 같은 결과를 쓰도록 분석을 한곳에 모았다.
 *
 * 웹은 onEvent 를 SSE 로 흘려보내고, CI 는 반환된 CollisionReport 만 쓴다.
 * 두 경로가 갈라지면 화면에서 본 것과 PR 코멘트에 적힌 것이 달라진다.
 */
export async function runCollisionAnalysis(input: AnalysisInput): Promise<CollisionReport> {
  const emit: OnEvent = input.onEvent ?? (() => {})
  const log = (message: string) => emit({ event: 'log', message })
  const started = Date.now()

  const repo = input.repo
  const report: CollisionReport = {
    repo,
    prs: [],
    spec: null,
    combinations: [],
    collisions: [],
    checkedCount: 0,
    collisionCount: 0,
    elapsedMs: 0,
  }

  let dispose: (() => Promise<void>) | null = null

  try {
    emit({ event: 'phase', name: 'PR 수집' })
    const prs =
      input.prs ?? (await Promise.all((input.numbers ?? []).map((n) => fetchPr(repo, n))))
    if (prs.length < 2) throw new Error('PR 이 두 개 이상 필요합니다')

    for (const p of prs) log(`#${p.number} ${p.title}`)
    report.prs = prs.map((p) => ({ number: p.number, title: p.title, files: p.files }))

    const spec = await findSpec(repo)
    report.spec = spec?.path ?? null
    log(spec ? `명세 발견: ${spec.path}` : '명세 문서 없음. 기대값 근거가 약해집니다')

    const combos = (input.combos ?? pickCombos)(prs)
    emit({
      event: 'plan',
      repo,
      prs: report.prs,
      combos: combos.map((c) => c.label),
      spec: report.spec,
    })
    log(`조합 ${combos.length}개를 검사합니다`)

    // 샌드박스는 하나만 띄우고 git reset 으로 되돌려 재사용한다
    emit({ event: 'phase', name: '샌드박스 준비' })
    const { collider, baseRef } = await openSandbox(repo, log)
    dispose = collider.dispose

    const sourceFiles = await listSourceFiles(collider)
    const specText = spec?.content ?? ''

    for (const [index, combo] of combos.entries()) {
      emit({ event: 'combo:start', index, label: combo.label })
      const base = { index, label: combo.label, prs: combo.prs.map((p) => p.number) }

      const finish = (r: Omit<CombinationResult, 'index' | 'label' | 'prs'>) => {
        const full: CombinationResult = { ...base, ...r }
        report.combinations.push(full)
        if (full.verdict === 'collision') report.collisions.push(full)
        emit({
          event: 'combo:done',
          index,
          verdict: full.verdict,
          note: full.note,
          assertion: full.assertion,
          output: full.output?.slice(-1200),
        })
      }

      const credits = await nosanaCredits()
      if (credits) emit({ event: 'credits', ...credits })
      if (shouldStop(credits)) {
        log('크레딧이 거의 없어 남은 조합을 건너뜁니다')
        finish({ verdict: 'skipped', note: '크레딧 부족' })
        break
      }

      const merged = await mergeCombination(collider, baseRef, combo.prs, log)
      if (!merged.cleanly) {
        finish({ verdict: 'conflict', note: 'git 충돌' })
        continue
      }

      const existing = await runExistingTests(collider, log)
      emit({
        event: 'combo:existing',
        index,
        ...existing,
        output: existing.output.slice(-800),
      })
      const existingSummary = {
        passed: existing.passed,
        total: existing.total,
        failed: existing.failed,
      }

      if (!existing.passed) {
        finish({ verdict: 'existing-fail', note: '기존 테스트 실패', existing: existingSummary })
        continue
      }

      const sample = await readSampleTest(
        collider,
        [...new Set(combo.prs.flatMap((p) => p.files))].filter((f) => !/(test|spec)\./.test(f)),
      )

      // 기존 테스트가 통과할 때만 생성한다. 크레딧을 아끼는 자리다.
      // 한 조합이 실패해도 나머지 조합은 계속 검사한다.
      try {
        // diff 길이를 키에 넣었더니 gh 버전에 따라 diff 문자열이 달라져서
        // CI 에서 캐시가 전부 빗나갔다. PR 번호만 쓰고 순서도 고정한다.
        // #1 + #2 와 #2 + #1 은 같은 조합이므로 같은 결과를 써야 한다.
        const cacheKey = [
          repo,
          combo.prs.map((p) => p.number).sort((a, b) => a - b).join('+'),
        ]
        const hypothesis = (
          await generateWithCache([...cacheKey, 'h'], () => hypothesize(combo.prs, specText, log), log)
        ).value
        emit({ event: 'combo:hypothesis', index, ...hypothesis })

        const test = (
          await generateWithCache(
            [...cacheKey, 't'],
            () => writeInteractionTest(combo.prs, specText, hypothesis, sample, sourceFiles, log),
            log,
          )
        ).value
        emit({ event: 'combo:test', index, content: test.content })

        const interaction = await runInteractionTest(collider, test, log)
        const assertion = extractAssertion(interaction.output)
        await clearGeneratedTest(collider, test.path)

        finish({
          verdict: interaction.failed > 0 ? 'collision' : 'safe',
          existing: existingSummary,
          hypothesis,
          test: test.content,
          assertion,
          output: interaction.output,
        })
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        log(`${combo.label} 생성 실패: ${why}`)
        finish({ verdict: 'error', note: why, existing: existingSummary })
      }
    }

    report.checkedCount = report.combinations.filter(
      (c) => c.verdict === 'collision' || c.verdict === 'safe',
    ).length
    report.collisionCount = report.collisions.length
  } catch (err) {
    report.checkError = err instanceof Error ? err.message : String(err)
    emit({ event: 'error', message: report.checkError })
  } finally {
    if (dispose) await dispose().catch(() => {})
  }

  report.elapsedMs = Date.now() - started
  emit({ event: 'done', elapsedMs: report.elapsedMs, credits: await nosanaCredits() })
  return report
}
