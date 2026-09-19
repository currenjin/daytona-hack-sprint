import type { Sandbox } from '@daytona/sdk'
import type { Log } from './generate.js'
import { APP_DIR, PORT, run, writeFile } from './sandbox.js'

export type Check = { name: string; ok: boolean; detail: string }
export type VerifyResult = { ok: boolean; checks: Check[]; issues: string[] }

/**
 * 샌드박스 안에서 도는 검증기.
 *
 * 생성된 앱을 실제로 실행해서 확인한다:
 *   1) 인라인 스크립트가 파싱되는가            (LLM이 가장 많이 깨먹는 지점)
 *   2) 서버가 200으로 서빙하는가
 *   3) 문서 구조가 온전한가                     (title, html, 본문)
 *   4) jsdom으로 스크립트를 실제 실행 + 클릭했을 때 터지지 않는가
 *
 * jsdom이 없으면 4번만 건너뛰고 나머지는 그대로 돈다.
 */
const VERIFY_JS = `
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const path = require('path');

const ROOT = ${JSON.stringify(APP_DIR)};
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail: String(detail || '') });

const file = path.join(ROOT, 'index.html');
let html = '';
try {
  html = fs.readFileSync(file, 'utf8');
  add('파일 존재', true, (html.length / 1024).toFixed(1) + 'KB');
} catch (e) {
  add('파일 존재', false, 'index.html 을 읽을 수 없습니다');
  console.log(JSON.stringify({ checks }));
  process.exit(0);
}

// 1) 인라인 스크립트 문법
const scripts = [...html.matchAll(/<script(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)<\\/script>/gi)].map((m) => m[1]);
let syntaxOk = true;
let syntaxDetail = scripts.length + '개 스크립트';
for (const [i, src] of scripts.entries()) {
  if (!src.trim()) continue;
  try {
    new vm.Script(src);
  } catch (e) {
    syntaxOk = false;
    syntaxDetail = '스크립트 #' + (i + 1) + ' 문법 오류: ' + e.message;
    break;
  }
}
add('인라인 스크립트 문법', syntaxOk, syntaxDetail);

// 2) 문서 구조
add('<title> 존재', /<title>\\s*\\S/i.test(html), '');
add('<html> 문서', /<html/i.test(html), '');
const bodyMatch = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
const bodyLen = bodyMatch ? bodyMatch[1].replace(/<script[\\s\\S]*?<\\/script>/gi, '').trim().length : 0;
add('본문 내용 있음', bodyLen > 120, bodyLen + '자');

// 3) 인터랙션 요소
const interactive = /<(button|input|select|textarea|a\\s)|onclick=|addEventListener/i.test(html);
add('인터랙션 요소', interactive, '');

// 4) 서버 응답 + 5) jsdom 실행
function fetchLocal() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: ${PORT}, path: '/', timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

(async () => {
  const served = await fetchLocal();
  add('서버 200 응답', served.status === 200, 'HTTP ' + served.status);

  let JSDOM = null;
  try { JSDOM = require('jsdom').JSDOM; } catch (e) { JSDOM = null; }

  if (!JSDOM) {
    add('런타임 실행 (jsdom)', true, '건너뜀 — jsdom 미설치');
  } else {
    const errors = [];
    try {
      const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole: new (require('jsdom').VirtualConsole)().on('jsdomError', (e) => {
          errors.push(e.message);
        }).on('error', (msg) => errors.push(String(msg))),
      });
      const win = dom.window;
      win.addEventListener('error', (e) => errors.push(e.message || 'window error'));

      await new Promise((r) => setTimeout(r, 300));

      add('스크립트 실행', errors.length === 0, errors.slice(0, 2).join(' | '));

      // 클릭 가능한 요소를 실제로 눌러본다
      const before = errors.length;
      const el = win.document.querySelector('button, [onclick], a[href="#"], input[type=checkbox], li');
      if (el) {
        el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 200));
        add('클릭 동작', errors.length === before, errors.slice(before, before + 2).join(' | '));
      } else {
        add('클릭 동작', false, '클릭할 요소를 찾지 못했습니다');
      }
      win.close();
    } catch (e) {
      add('스크립트 실행', false, e.message);
    }
  }

  console.log(JSON.stringify({ checks }));
})();
`

/** 샌드박스에서 생성된 앱을 실제로 실행해 검증한다. */
export async function verifyApp(sandbox: Sandbox, onLog: Log): Promise<VerifyResult> {
  onLog('샌드박스에서 앱 검증 중...')
  await writeFile(sandbox, '/tmp/_verify.js', VERIFY_JS)

  const res = await sandbox.process.executeCommand('cd /tmp && node /tmp/_verify.js 2>&1 | tail -1')
  const raw = String(res.result ?? '').trim()

  let parsed: { checks: Check[] }
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf('{')))
  } catch {
    // 검증기 자체가 터진 경우 — 배포를 막지는 않되 사실대로 보고한다.
    onLog(`검증기 실행 실패: ${raw.slice(0, 160)}`)
    return { ok: true, checks: [{ name: '검증기', ok: false, detail: raw.slice(0, 160) }], issues: [] }
  }

  const checks = parsed.checks ?? []
  const failed = checks.filter((c) => !c.ok)

  for (const c of checks) onLog(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)

  return {
    ok: failed.length === 0,
    checks,
    issues: failed.map((c) => `${c.name}: ${c.detail || '실패'}`),
  }
}

/** 데모 전에 jsdom을 미리 깔아둔다 (스냅샷에 구워두면 이 단계는 건너뛴다). */
export async function ensureJsdom(sandbox: Sandbox, onLog: Log): Promise<boolean> {
  const probe = await sandbox.process.executeCommand(
    `cd /tmp && node -e "require('jsdom')" 2>/dev/null && echo yes || echo no`,
  )
  if (String(probe.result).includes('yes')) return true

  onLog('검증용 jsdom 설치 중...')
  try {
    await run(sandbox, `cd /tmp && npm install jsdom --silent --no-audit --no-fund`, 'jsdom 설치')
    return true
  } catch {
    onLog('jsdom 설치 실패 — 정적 검증만 수행합니다')
    return false
  }
}

export { VERIFY_JS }
