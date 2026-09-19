import { Daytona } from '@daytona/sdk'
import type { Log } from './generate.js'

const APP_DIR = '/tmp/app'
const PORT = 3000

/**
 * 샌드박스 안에서 돌릴 정적 서버. 의존성 0, 순수 node.
 * 리스닝을 시작하면 /tmp/.ready 를 남긴다 — 호스트에서 기동 완료를 폴링하는 신호.
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
      // SPA 성격의 앱을 대비해 index.html 로 폴백
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

export type Launched = { sandboxId: string; previewUrl: string }

/** 파일 묶음을 Daytona 샌드박스에 올리고, 공개 preview URL을 반환한다. */
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

  const run = async (cmd: string, label: string) => {
    const res = await sandbox.process.executeCommand(cmd)
    if (res.exitCode !== 0) {
      throw new Error(`${label} 실패 (exit ${res.exitCode}): ${String(res.result).slice(0, 400)}`)
    }
    return res
  }

  await run(`rm -rf ${APP_DIR} && mkdir -p ${APP_DIR} && rm -f /tmp/.ready`, '작업 디렉토리 생성')

  // base64로 넘겨서 따옴표/개행 이스케이프 문제를 원천 차단한다.
  for (const [name, content] of Object.entries(files)) {
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const target = `${APP_DIR}/${name}`
    await run(`mkdir -p "$(dirname '${target}')" && echo '${b64}' | base64 -d > '${target}'`, `${name} 업로드`)
  }

  const serveB64 = Buffer.from(SERVE_JS, 'utf8').toString('base64')
  await run(`echo '${serveB64}' | base64 -d > /tmp/_serve.js`, '서버 스크립트 업로드')

  onLog('서버 기동 중...')
  // executeCommand 반환 후에도 살아있도록 nohup + 백그라운드.
  await run(`nohup node /tmp/_serve.js > /tmp/serve.log 2>&1 & echo started`, '서버 실행')

  // 리스닝 신호 대기 (최대 20초)
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
  return { sandboxId: sandbox.id, previewUrl: link.url }
}
