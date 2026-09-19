// PR 코멘트 본문(마크다운) 을 만든다.
// CI 는 COLLIDER_MARKER 로 기존 코멘트를 찾아 새로 달지 않고 교체한다.

import type { PrRef, PrReport } from './svg.js'

export const COLLIDER_MARKER = '<!-- collider-report -->'

// 개행이 들어가면 표/목록 항목이 끊긴다. 한 줄로 눌러둔다.
function plain(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// 표 셀 안의 | 는 열 구분자로 먹히므로 이스케이프한다.
// 코드 스팬(`...`) 안에서는 백슬래시가 이스케이프로 동작하지 않아 \| 가 그대로 보이니 plain 을 쓸 것.
function cell(s: string): string {
  return plain(s).replace(/\|/g, '\\|')
}

// 목적지에 괄호나 공백이 있으면 링크가 깨진다. 그럴 때만 <> 로 감싼다.
function mdUrl(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, '')}>` : url
}

function prLabel(pr: PrRef): string {
  return pr.title ? `#${pr.number} ${cell(pr.title)}` : `#${pr.number}`
}

function table(rows: [string, string][]): string[] {
  if (rows.length === 0) return []
  return [
    '| | |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| **${cell(k)}** | ${cell(v)} |`),
  ]
}

// 검사 범위. 결과를 과장하지 않기 위해 성공/실패 양쪽에 항상 붙인다.
function scopeLines(prs: PrRef[]): string[] {
  if (prs.length === 0) return ['No other open PRs were checked.']
  return [
    'Checked with',
    '',
    ...prs.map((pr) => `- ${prLabel(pr)} — passed`),
  ]
}

function failureFallback(r: PrReport): string[] {
  const c = r.collision
  const rows: [string, string][] = []
  if (c) rows.push(['Collides with', c.withPrTitle ? `#${c.withPr} ${c.withPrTitle}` : `#${c.withPr}`])
  if (c?.impact) rows.push(['What breaks', c.impact])
  if (r.existingTests) {
    const { passed, total } = r.existingTests
    rows.push(['Existing CI', `${passed} / ${total} passed`])
  }
  if (c?.expected !== undefined) rows.push(['Expected', c.expected])
  if (c?.actual !== undefined) rows.push(['Actual', c.actual])

  const out = [...table(rows)]
  if (r.checkedPrs.length > 0) {
    out.push('', `Checked with ${r.checkedPrs.map((p) => `#${p.number}`).join(', ')}`)
  } else {
    out.push('', 'No other open PRs were checked.')
  }
  return out
}

function successFallback(r: PrReport): string[] {
  const rows: [string, string][] = []
  if (r.existingTests) {
    const { passed, total } = r.existingTests
    rows.push(['Existing CI', `${passed} / ${total} passed`])
  }
  const n = r.checkedPrs.length
  rows.push(['Combinations', `${n} / ${n} passed`])

  return [...table(rows), '', ...scopeLines(r.checkedPrs)]
}

export function renderCommentBody(r: PrReport, opts: { svgUrl?: string; reportUrl?: string }): string {
  const failed = Boolean(r.collision)
  const heading = failed
    ? `Future collision with #${r.collision!.withPr}`
    : 'No future collision found'
  const summary = failed
    ? 'This PR is not safe to merge yet.'
    : 'This PR passed all checked combinations.'

  const lines: string[] = [
    COLLIDER_MARKER,
    `**Collider** · \`${plain(r.repo)}\` · PR #${r.currentPr.number}`,
    '',
    `### ${heading}`,
    '',
    summary,
    '',
  ]

  // SVG 를 못 올렸거나 GitHub 이 그림을 대신 받아오지 못해도 코멘트만 읽고
  // 결론이 나와야 한다. 같은 내용을 항상 표와 목록으로 함께 적는다.
  const detail = failed ? failureFallback(r) : successFallback(r)

  if (opts.svgUrl) {
    lines.push(
      `![Collider report](${mdUrl(opts.svgUrl)})`,
      '',
      '<details><summary>Details</summary>',
      '',
      ...detail,
      '',
      '</details>',
    )
  } else {
    lines.push(...detail)
  }

  if (opts.reportUrl) {
    lines.push('', `[View full report](${mdUrl(opts.reportUrl)})`)
  }

  return lines.join('\n') + '\n'
}

// Daytona/Nosana/생성 실패는 충돌이 아니다. 충돌 리포트와 같은 제목/표를 쓰지 않는다.
export function renderErrorCommentBody(repo: string, reason: string): string {
  const why = plain(reason) || 'Unknown error.'
  return (
    [
      COLLIDER_MARKER,
      'Collider could not complete the check.',
      '',
      `Reason: ${why}`,
      '',
      `No collision result was produced for \`${plain(repo)}\`. This is not a collision report — nothing was found or ruled out.`,
    ].join('\n') + '\n'
  )
}
