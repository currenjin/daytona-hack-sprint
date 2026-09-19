import { Daytona, type Sandbox } from '@daytona/sdk'
import type { Log } from './generate.js'

const APP_DIR = '/tmp/app'
const PORT = 3000

/**
 * 샌드박스 안에서 돌릴 정적 서버. 의존성 0, 순수 node.
 * 리스닝을 시작하면 /tmp/.ready 를 남긴다 — 호스트에서 기동 완료를 폴링하는 신호.
 *
 * 디스크에서 매 요청마다 읽으므로, 파일만 덮어쓰면 재배포가 끝난다 (재시작 불필요).
 */
const SERVE_JS = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = ${JSON.stringify(APP_DIR)};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\\.\\.[/\\\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(idx);
      });
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(buf);
  });
}).listen(${PORT}, '0.0.0.0', () => {
  fs.writeFileSync('/tmp/.ready', 'ok');
  console.log('serving on ${PORT}');
});
`

export type Launched = { sandbox: Sandbox; sandboxId: string; previewUrl: string }

/** 명령 실행 + 실패 시 읽을 수 있는 에러. */
export async function run(sandbox: Sandbox, cmd: string, label: string) {
  const res = await sandbox.process.executeCommand(cmd)
  if (res.exitCode !== 0) {
    throw new Error(`${label} 실패 (exit ${res.exitCode}): ${String(res.result).slice(0, 400)}`)
  }
  return res
}

/** 파일을 샌드박스에 쓴다. base64로 넘겨 이스케이프 문제를 원천 차단. */
export async function writeFile(sandbox: Sandbox, absPath: string, content: string) {
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  await run(
    sandbox,
    `mkdir -p "$(dirname '${absPath}')" && echo '${b64}' | base64 -d > '${absPath}'`,
    `${absPath} 쓰기`,
  )
}

/** 앱 파일을 교체한다. 정적 서버가 디스크를 읽으므로 이것만으로 재배포가 끝난다. */
export async function deployFiles(
  sandbox: Sandbox,
  files: Record<string, string>,
  onLog: Log,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(sandbox, `${APP_DIR}/${name}`, content)
  }
  onLog(`샌드박스에 배포됨 (${Object.keys(files).join(', ')})`)
}

/** 샌드박스를 띄우고 앱을 배포한 뒤, 공개 preview URL을 반환한다. */
export async function launchSandbox(
  files: Record<string, string>,
  onLog: Log,
): Promise<Launched> {
  const daytona = new Daytona() // DAYTONA_API_KEY 환경변수 사용

  onLog('Daytona 샌드박스 부팅...')
  const sandbox = await daytona.create(
    {
      language: 'typescript',
      public: true, // 토큰 없이 preview URL 접근 가능
      autoStopInterval: 60,
      ...(process.env.DAYTONA_SNAPSHOT ? { snapshot: process.env.DAYTONA_SNAPSHOT } : {}),
    },
    { timeout: 180 },
  )
  onLog(`샌드박스 준비됨 (${sandbox.id})`)

  await run(sandbox, `rm -rf ${APP_DIR} && mkdir -p ${APP_DIR} && rm -f /tmp/.ready`, '작업 디렉토리 생성')
  await deployFiles(sandbox, files, onLog)
  await writeFile(sandbox, '/tmp/_serve.js', SERVE_JS)

  onLog('서버 기동 중...')
  await run(sandbox, `nohup node /tmp/_serve.js > /tmp/serve.log 2>&1 & echo started`, '서버 실행')

  let ready = false
  for (let i = 0; i < 20; i++) {
    const res = await sandbox.process.executeCommand('cat /tmp/.ready 2>/dev/null || true')
    if (String(res.result).includes('ok')) { ready = true; break }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!ready) {
    const log = await sandbox.process.executeCommand('cat /tmp/serve.log 2>/dev/null || true')
    throw new Error(`서버가 뜨지 않았습니다: ${String(log.result).slice(0, 400)}`)
  }

  const link = await sandbox.getPreviewLink(PORT)
  onLog(`샌드박스 라이브: ${link.url}`)
  return { sandbox, sandboxId: sandbox.id, previewUrl: link.url }
}

export { APP_DIR, PORT }
