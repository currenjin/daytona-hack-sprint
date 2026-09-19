import type { PullRequest } from './github.js'

export type Combo = {
  /** 화면에 쓰는 이름. 예: #1 + #2 */
  label: string
  prs: PullRequest[]
}

/**
 * 검사할 조합을 고른다.
 *
 * 전부 돌리면 2^N 이라 PR 다섯 개만 돼도 26가지다. 실제로 문제가 나오는 자리는
 * 둘씩 만나는 지점과 전부 합친 지점이라 그 둘만 본다. 조합마다 Nosana 추론이
 * 한 번씩 들어가므로 수를 줄이는 것이 곧 크레딧을 줄이는 것이다.
 */
export function pickCombos(prs: PullRequest[]): Combo[] {
  const out: Combo[] = []

  for (let i = 0; i < prs.length; i++) {
    for (let j = i + 1; j < prs.length; j++) {
      out.push({ label: `#${prs[i]!.number} + #${prs[j]!.number}`, prs: [prs[i]!, prs[j]!] })
    }
  }

  if (prs.length > 2) {
    out.push({ label: prs.map((p) => `#${p.number}`).join(' + '), prs: [...prs] })
  }

  return out
}

/** PR 수에 따른 조합 수. 화면에 미리 알려 준다. */
export function comboCount(n: number): number {
  return (n * (n - 1)) / 2 + (n > 2 ? 1 : 0)
}
