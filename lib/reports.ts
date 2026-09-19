import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { PrReport } from './svg.js'

const DIR = '.collider-reports'

/**
 * CI 는 GitHub Actions 러너에서 돌고 웹 서버는 다른 곳에 있다.
 * 러너가 분석을 끝내면 결과를 서버로 보내고, 서버가 준 URL 을 PR 코멘트에 넣는다.
 * 그래서 저장소가 서버 쪽에 있어야 한다.
 */
export function reportId(r: PrReport): string {
  const seed = `${r.repo}#${r.currentPr.number}:${r.checkedPrs.map((p) => p.number).join(',')}:${
    r.collision ? `c${r.collision.withPr}` : 'ok'
  }`
  return createHash('sha256').update(seed).digest('hex').slice(0, 12)
}

export async function saveReport(r: PrReport): Promise<string> {
  const id = reportId(r)
  await mkdir(DIR, { recursive: true })
  await writeFile(join(DIR, `${id}.json`), JSON.stringify(r, null, 2))
  return id
}

export async function loadReport(id: string): Promise<PrReport | null> {
  if (!/^[a-f0-9]{6,64}$/.test(id)) return null // 경로 탈출 방지
  try {
    return JSON.parse(await readFile(join(DIR, `${id}.json`), 'utf8')) as PrReport
  } catch {
    return null
  }
}
