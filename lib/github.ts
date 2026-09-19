import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type PullRequest = {
  number: number
  title: string
  body: string
  headRef: string
  files: string[]
  diff: string
}

/** owner/repo#number 형태 또는 URL에서 레포와 PR 번호를 뽑는다. */
export function parsePr(input: string): { repo: string; number: number } {
  const url = input.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  if (url) return { repo: url[1]!, number: Number(url[2]) }

  const short = input.match(/^([^/\s]+\/[^/#\s]+)#(\d+)$/)
  if (short) return { repo: short[1]!, number: Number(short[2]) }

  throw new Error(`PR 형식을 알 수 없습니다: ${input} (예: owner/repo#1 또는 PR URL)`)
}

/** gh CLI로 PR 메타데이터와 diff를 가져온다. */
export async function fetchPr(repo: string, number: number): Promise<PullRequest> {
  const { stdout: metaRaw } = await exec('gh', [
    'pr', 'view', String(number),
    '--repo', repo,
    '--json', 'number,title,body,headRefName,files',
  ])
  const meta = JSON.parse(metaRaw) as {
    number: number
    title: string
    body: string | null
    headRefName: string
    files: { path: string }[]
  }

  const { stdout: diff } = await exec(
    'gh',
    ['pr', 'diff', String(number), '--repo', repo],
    { maxBuffer: 10 * 1024 * 1024 },
  )

  return {
    number: meta.number,
    title: meta.title,
    body: meta.body ?? '',
    headRef: meta.headRefName,
    files: meta.files.map((f) => f.path),
    diff,
  }
}

/** 레포에서 파일 하나를 읽는다 (SPEC 문서 등). 없으면 빈 문자열. */
export async function fetchFile(repo: string, path: string, ref = 'HEAD'): Promise<string> {
  try {
    const { stdout } = await exec('gh', [
      'api', `repos/${repo}/contents/${path}?ref=${ref}`,
      '--jq', '.content',
    ])
    return Buffer.from(stdout.trim(), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** 레포에 있는 명세/규칙 문서를 찾는다. 생성 테스트의 기대값 근거가 된다. */
export async function findSpec(repo: string): Promise<{ path: string; content: string } | null> {
  for (const path of ['SPEC.md', 'docs/SPEC.md', 'CONTRIBUTING.md', 'README.md']) {
    const content = await fetchFile(repo, path)
    if (content.trim().length > 200) return { path, content }
  }
  return null
}

/** 지금 열려 있는 PR 번호들. CI 가 현재 PR 과 짝지을 대상을 찾는다. */
export async function listOpenPrs(repo: string): Promise<{ number: number; title: string }[]> {
  const { stdout } = await exec('gh', [
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '30', '--json', 'number,title',
  ])
  return JSON.parse(stdout) as { number: number; title: string }[]
}

/**
 * 같은 PR 에 코멘트를 쌓지 않는다. 표시가 있는 기존 코멘트를 찾아 갈아끼운다.
 * PR 을 push 할 때마다 workflow 가 돌기 때문에 이 처리가 없으면 코멘트가 줄줄이 쌓인다.
 */
export async function upsertComment(
  repo: string,
  prNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  let existing: { id: number; body: string }[] = []
  try {
    const { stdout } = await exec(
      'gh',
      ['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate'],
      { maxBuffer: 10 * 1024 * 1024 },
    )
    existing = JSON.parse(stdout) as { id: number; body: string }[]
  } catch {
    existing = []
  }

  const mine = existing.find((c) => (c.body ?? '').includes(marker))
  const args = mine
    ? ['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '-f', `body=${body}`]
    : ['api', '--method', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '-f', `body=${body}`]

  await exec('gh', args, { maxBuffer: 10 * 1024 * 1024 })
}
