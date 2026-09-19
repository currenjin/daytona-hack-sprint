import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const BRANCH = 'collider-reports'

/**
 * 리포트 SVG 를 레포의 별도 브랜치에 올리고 raw 주소를 돌려준다.
 *
 * GitHub 코멘트에 그림을 띄우려면 공개 주소가 필요하다. 웹 서버를 공개 주소에
 * 띄워 두는 방법도 있지만, 서버가 내려가면 발표 도중 코멘트의 그림이 깨진다.
 * 레포에 올려 두면 서버 없이도 남는다.
 *
 * 검사 대상 브랜치와 섞이지 않게 별도 브랜치를 쓴다. main 에 올리면 히스토리가
 * 리포트로 채워진다.
 */
export async function publishSvg(repo: string, id: string, svg: string): Promise<string | null> {
  try {
    await ensureBranch(repo)
    const path = `${id}.svg`

    // 같은 PR 을 다시 검사하면 경로가 같다. 덮어쓰려면 기존 blob 의 sha 가 필요하다.
    const sha = await currentSha(repo, path)
    const args = [
      'api', '--method', 'PUT', `repos/${repo}/contents/${path}`,
      '-f', `message=collider report ${id}`,
      '-f', `content=${Buffer.from(svg, 'utf8').toString('base64')}`,
      '-f', `branch=${BRANCH}`,
    ]
    if (sha) args.push('-f', `sha=${sha}`)
    await exec('gh', args, { maxBuffer: 10 * 1024 * 1024 })

    return `https://raw.githubusercontent.com/${repo}/${BRANCH}/${path}`
  } catch (err) {
    // 그림이 없어도 코멘트 본문만으로 결과를 읽을 수 있다. 여기서 멈추지 않는다.
    console.warn(`collider: SVG 업로드 실패, 코멘트는 표로 남깁니다 (${String(err)})`)
    return null
  }
}

async function ensureBranch(repo: string): Promise<void> {
  try {
    await exec('gh', ['api', `repos/${repo}/branches/${BRANCH}`])
    return
  } catch {
    /* 없으면 만든다 */
  }

  const { stdout } = await exec('gh', ['api', `repos/${repo}`, '--jq', '.default_branch'])
  const base = stdout.trim()
  const { stdout: headRaw } = await exec('gh', [
    'api', `repos/${repo}/git/ref/heads/${base}`, '--jq', '.object.sha',
  ])

  await exec('gh', [
    'api', '--method', 'POST', `repos/${repo}/git/refs`,
    '-f', `ref=refs/heads/${BRANCH}`,
    '-f', `sha=${headRaw.trim()}`,
  ])
}

async function currentSha(repo: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await exec('gh', [
      'api', `repos/${repo}/contents/${path}?ref=${BRANCH}`, '--jq', '.sha',
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}
