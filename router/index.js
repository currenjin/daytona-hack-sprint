#!/usr/bin/env node
/**
 * VPS에 올리는 라우터. 의존성 0, 순수 node.
 *
 *   POST /_register  { slug, target, secret }  → slug → target 매핑 저장
 *   그 외 모든 요청   → Host 헤더에서 slug 추출 → 해당 target으로 프록시
 *
 * 앞단은 Caddy가 와일드카드 TLS를 종료하고 이쪽(8080)으로 넘긴다.
 *
 *   PORT=8080 ROUTER_SECRET=... node router/index.js
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import { URL } from 'node:url'

const PORT = Number(process.env.PORT || 8080)
const SECRET = process.env.ROUTER_SECRET || ''
const STORE = process.env.ROUTER_STORE || '/tmp/ship-routes.json'

/** @type {Map<string, string>} slug → target URL */
const routes = new Map()

try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(STORE, 'utf8')))) routes.set(k, v)
  console.log(`[router] ${routes.size}개 라우트 복원`)
} catch {
  // 최초 실행 — 무시
}

function persist() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries(routes)))
  } catch (err) {
    console.error('[router] 저장 실패', err.message)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

const NOT_FOUND = (slug) => `<!doctype html>
<html lang="ko"><meta charset="utf-8">
<title>아직 배포되지 않았습니다</title>
<body style="background:#0b0d10;color:#e8eaed;font:16px/1.7 system-ui,sans-serif;
             display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div>
  <h1 style="color:#5eead4;margin:0 0 8px">아직 배포되지 않았습니다</h1>
  <p style="color:#8b949e;margin:0">${slug ? `<code>${slug}</code> 에 연결된 앱이 없습니다.` : '알 수 없는 주소입니다.'}</p>
</div></body></html>`

/** target으로 프록시. 리다이렉트는 1회까지 따라간다. */
function proxy(req, res, targetUrl, depth = 0) {
  let target
  try {
    target = new URL(req.url || '/', targetUrl)
  } catch {
    res.writeHead(502, { 'content-type': 'text/plain' }).end('bad target')
    return
  }

  const client = target.protocol === 'http:' ? http : https
  const headers = { ...req.headers }
  delete headers.host // 업스트림(Daytona)의 SNI/Host를 그대로 쓰게 둔다
  delete headers['accept-encoding'] // 그대로 파이프하므로 인코딩 협상은 생략

  const upstream = client.request(
    target,
    { method: req.method, headers, timeout: 15000 },
    (up) => {
      const loc = up.headers.location
      if (loc && up.statusCode >= 300 && up.statusCode < 400 && depth < 1) {
        up.resume()
        proxy(req, res, new URL(loc, target).toString(), depth + 1)
        return
      }
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
  upstream.on('error', (err) => {
    console.error('[router] upstream 오류', err.message)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('upstream error')
  })

  req.pipe(upstream)
}

http
  .createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/_register') {
      try {
        const { slug, target, secret } = JSON.parse(await readBody(req))
        if (SECRET && secret !== SECRET) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
          return
        }
        if (!slug || !target) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end('slug and target required')
          return
        }
        routes.set(String(slug), String(target))
        persist()
        console.log(`[router] ${slug} → ${target}`)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(String(err.message))
      }
      return
    }

    if (req.url === '/_routes') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(Object.fromEntries(routes), null, 2))
      return
    }

    // <slug>.ship.<zone> 에서 slug 추출
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    const slug = host.split(':')[0].split('.')[0]
    const target = routes.get(slug)

    if (!target) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(NOT_FOUND(slug))
      return
    }
    proxy(req, res, target)
  })
  .listen(PORT, () => console.log(`[router] :${PORT} 대기 중 (store: ${STORE})`))
