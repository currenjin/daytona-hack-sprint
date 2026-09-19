// Collider 결과 카드를 SVG 문자열로 만든다.
// GitHub 코멘트에서는 <img> 로 렌더되므로 외부 폰트/이미지/스크립트를 쓸 수 없고,
// prefers-color-scheme 도 적용되지 않는다. 밝은 배경 한 벌로 고정한다.

export type PrRef = { number: number; title?: string }

export type PrReport = {
  repo: string
  currentPr: PrRef
  checkedPrs: PrRef[]
  existingTests?: { passed: number; total: number }
  collision?: {
    withPr: number
    withPrTitle?: string
    impact?: string // 예: "Discount calculation"
    expected?: string // 예: "₩8,000"
    actual?: string // 예: "₩8,100"
  }
}

// docs/mockups/*.svg 에서 그대로 가져온 시각 언어.
const W = 880
const PAD = 40
const RIGHT = W - PAD

const INK = '#24292f'
const MUTED = '#57606a'
const RED = '#cf222e'
const GREEN = '#1a7f37'
const LINE = '#d0d7de'
const BOX_BG = '#f6f8fa'
const BOX_LINE = '#d8dee4'
const DANGER_BG = '#fff1f0'
const DANGER_LINE = '#ffcecb'

// GitHub 은 SVG 안의 외부 폰트(@font-face, Google Fonts)를 차단한다. system stack 으로 고정한다.
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

// PR 제목에 & 가 흔하다. 텍스트 노드와 속성값 양쪽에서 안전하도록 다섯 글자를 모두 막는다.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// 개행/탭이 들어오면 SVG 한 줄 안에서 레이아웃이 깨지므로 공백 한 칸으로 눌러둔다.
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// 순수 함수라 실제 폰트 메트릭을 잴 수 없다. Arial/Helvetica 의 advance width(1000 단위)를
// 표로 들고 근사한다. 평균 폭 한 값으로 뭉뚱그리면 대문자/CJK 가 섞일 때 과소평가해서
// 텍스트가 카드 밖으로 샌다.
const ADV: Record<string, number> = {}
for (const [chars, w] of [
  ["'", 191],
  ['ijl', 222],
  ['|', 260],
  [' !,./:;I[]\\ft', 278],
  ['()-`r{}', 333],
  ['"', 355],
  ['*', 389],
  ['^', 469],
  ['Jckpsvxyz', 500],
  ['#$?_L0123456789abdeghnoqu', 556],
  ['+<=>~', 584],
  ['FTZ', 611],
  ['&ABEKPSVXY', 667],
  ['CDHNRUw', 722],
  ['GOQ', 778],
  ['Mm', 833],
  ['%', 889],
  ['W', 944],
  ['@', 1015],
] as [string, number][]) {
  for (const ch of chars) ADV[ch] = w
}

// system stack 의 실제 폰트(SF Pro 등)가 Arial 보다 조금 넓을 수 있어 여유를 둔다.
const SAFETY = 1.05
const BOLD_RATIO = 1.09

function estimateWidth(s: string, fontSize: number, bold = false): number {
  let units = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x11ff)) {
      units += 1000 // 한글/CJK/전각 기호는 1em
    } else {
      units += ADV[ch] ?? 600 // 표에 없는 기호(₩, ✓, · …)는 넉넉하게
    }
  }
  return (units / 1000) * fontSize * (bold ? BOLD_RATIO : 1) * SAFETY
}

// 길면 잘라내고 … 을 붙인다.
function fit(s: string, maxWidth: number, fontSize: number, bold = false): string {
  const src = oneLine(s)
  if (estimateWidth(src, fontSize, bold) <= maxWidth) return src
  const chars = [...src]
  while (chars.length > 1) {
    chars.pop()
    if (estimateWidth(chars.join('') + '…', fontSize, bold) <= maxWidth) break
  }
  return chars.join('').replace(/[\s,·-]+$/, '') + '…'
}

type TextOpts = {
  size: number
  fill: string
  bold?: boolean
  anchor?: 'start' | 'end'
  track?: number
}

function tx(x: number, y: number, s: string, o: TextOpts): string {
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${FONT}"`,
    `font-size="${o.size}"`,
    o.bold ? 'font-weight="700"' : '',
    o.anchor === 'end' ? 'text-anchor="end"' : '',
    o.track ? `letter-spacing="${o.track}"` : '',
    `fill="${o.fill}"`,
  ].filter(Boolean)
  return `<text ${attrs.join(' ')}>${esc(s)}</text>`
}

function box(x: number, y: number, w: number, h: number, rx: number, fill: string, stroke: string): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}"/>`
}

function card(height: number, label: string, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img">`,
    // 이미지로 임베드되므로 스크린리더가 읽을 수 있는 이름을 안에 넣어둔다.
    `<title>${esc(label)}</title>`,
    `<rect width="${W}" height="${height}" rx="24" fill="#ffffff"/>`,
    // 스트로크가 픽셀 경계에 걸치도록 0.5 만큼 안으로 넣는다.
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="23" fill="none" stroke="${LINE}"/>`,
    ...body,
    '</svg>',
  ].join('\n')
}

function prLabel(pr: PrRef): string {
  return pr.title ? `#${pr.number} ${oneLine(pr.title)}` : `#${pr.number}`
}

// 헤더는 두 카드가 동일하다. 마지막으로 쓴 baseline 을 돌려준다.
function header(out: string[], r: PrReport): number {
  const left = `COLLIDER · PR #${r.currentPr.number}`
  out.push(tx(PAD, 52, left, { size: 18, bold: true, fill: INK }))
  const used = estimateWidth(left, 18, true)
  const repoRoom = RIGHT - PAD - used - 24
  if (repoRoom > 60 && r.repo) {
    out.push(tx(RIGHT, 52, fit(r.repo, repoRoom, 13), { size: 13, fill: MUTED, anchor: 'end' }))
  }
  return 52
}

// "Checked with #31, #37, #41" 같은 검사 범위 한 줄. 결과를 과장하지 않기 위해 항상 붙인다.
function scopeLine(prs: PrRef[]): string {
  if (prs.length === 0) return 'No other open PRs were checked.'
  return `Checked with ${prs.map((p) => `#${p.number}`).join(', ')}`
}

export function renderFailureSvg(r: PrReport): string {
  const out: string[] = []
  let y = header(out, r)

  const c = r.collision
  const title = c ? `Future collision with #${c.withPr}` : 'Future collision detected'

  y += 60
  out.push(tx(PAD, y, fit(title, W - PAD * 2, 30, true), { size: 30, bold: true, fill: RED }))

  y += 34
  out.push(tx(PAD, y, 'This PR is not safe to merge yet.', { size: 17, fill: MUTED }))

  if (c) {
    // Collides with — 무엇과 부딪혔는지가 가장 먼저 와야 한다.
    const boxTop = y + 34
    const boxH = 82
    out.push(box(PAD, boxTop, W - PAD * 2, boxH, 14, DANGER_BG, DANGER_LINE))
    out.push(tx(PAD + 24, boxTop + 30, 'COLLIDES WITH', { size: 12, fill: MUTED, track: 0.6 }))
    const withLabel = c.withPrTitle ? `#${c.withPr} ${oneLine(c.withPrTitle)}` : `#${c.withPr}`
    out.push(
      tx(PAD + 24, boxTop + 62, fit(withLabel, W - PAD * 2 - 48, 22, true), {
        size: 22,
        bold: true,
        fill: INK,
      }),
    )
    y = boxTop + boxH
  }

  if (c?.impact) {
    y += 46
    out.push(tx(PAD, y, 'WHAT BREAKS', { size: 12, fill: MUTED, track: 0.6 }))
    y += 36
    out.push(tx(PAD, y, fit(c.impact, W - PAD * 2, 22, true), { size: 22, bold: true, fill: INK }))
  }

  // 라벨/값 2열. 값 열은 라벨이 가장 긴 "Existing CI" 기준으로 여유를 둔다.
  const valueX = PAD + 130

  if (r.existingTests) {
    y += 48
    const { passed, total } = r.existingTests
    const ok = total > 0 && passed === total
    out.push(tx(PAD, y, 'Existing CI', { size: 13, fill: MUTED }))
    out.push(
      tx(valueX, y, `${ok ? '✓' : '✕'} ${passed} / ${total}`, {
        size: 16,
        bold: true,
        fill: ok ? GREEN : RED,
      }),
    )
  }

  if (c?.expected !== undefined) {
    y += r.existingTests ? 44 : 48
    out.push(tx(PAD, y, 'Expected', { size: 13, fill: MUTED }))
    out.push(tx(valueX, y, fit(c.expected, RIGHT - valueX, 18, true), { size: 18, bold: true, fill: GREEN }))
  }

  if (c?.actual !== undefined) {
    y += 32
    out.push(tx(PAD, y, 'Actual', { size: 13, fill: MUTED }))
    out.push(tx(valueX, y, fit(c.actual, RIGHT - valueX, 18, true), { size: 18, bold: true, fill: RED }))
  }

  y += 40
  out.push(tx(PAD, y, fit(scopeLine(r.checkedPrs), W - PAD * 2, 12), { size: 12, fill: MUTED }))

  // 내용 높이에 맞춰 캔버스를 키운다. 고정 높이면 checkedPrs 개수에 따라 글자가 잘린다.
  return card(y + 34, title, out)
}

export function renderSuccessSvg(r: PrReport): string {
  const out: string[] = []
  let y = header(out, r)

  y += 60
  out.push(tx(PAD, y, 'No future collision found', { size: 30, bold: true, fill: GREEN }))

  y += 34
  out.push(tx(PAD, y, 'This PR passed all checked combinations.', { size: 17, fill: MUTED }))

  y += 46
  out.push(tx(PAD, y, 'CHECKED WITH', { size: 12, fill: MUTED, track: 0.6 }))

  const rows = r.checkedPrs
  const rowH = 44
  const boxTop = y + 16
  const boxH = Math.max(rows.length, 1) * rowH + 20
  out.push(box(PAD, boxTop, W - PAD * 2, boxH, 16, BOX_BG, BOX_LINE))

  if (rows.length === 0) {
    // 0 개일 때 빈 박스만 남으면 "검사했는데 통과" 로 오해된다. 범위를 명시한다.
    out.push(
      tx(PAD + 24, boxTop + 38, 'No other open PRs were available to check.', { size: 17, fill: MUTED }),
    )
  } else {
    rows.forEach((pr, i) => {
      const base = boxTop + 38 + rowH * i
      out.push(
        tx(PAD + 24, base, fit(prLabel(pr), W - PAD * 2 - 48 - 40, 18), { size: 18, fill: INK }),
      )
      out.push(tx(RIGHT - 24, base, '✓', { size: 20, bold: true, fill: GREEN, anchor: 'end' }))
    })
  }

  y = boxTop + boxH + 42
  const n = rows.length
  out.push(tx(PAD, y, `${n} / ${n} combinations passed`, { size: 15, bold: true, fill: INK }))

  if (r.existingTests) {
    const { passed, total } = r.existingTests
    y += 28
    out.push(tx(PAD, y, `Existing CI ${passed} / ${total} passed`, { size: 12, fill: MUTED }))
  }

  return card(y + 34, 'No future collision found', out)
}
