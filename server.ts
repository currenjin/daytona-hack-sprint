import express from 'express'
import QRCode from 'qrcode'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PORT } from './lib/env.js'
import { extractTitle, generateApp } from './lib/generate.js'
import { launchSandbox } from './lib/sandbox.js'
import { publish } from './lib/dns.js'
import { reviewApp } from './lib/nosana.js'
import { makeSlug } from './lib/slug.js'

const here = dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(express.json({ limit: '1mb' }))
app.use(express.static(join(here, 'public')))

app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/ship', async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim()

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: string, data: unknown) => {
    res.write(`data: ${JSON.stringify({ event, ...(data as object) })}\n\n`)
  }
  const log = (message: string) => send('log', { message })

  if (!prompt) {
    send('error', { message: '만들고 싶은 것을 한 줄로 적어주세요.' })
    return res.end()
  }

  const started = Date.now()
  // 네트워크가 끊겨도 프론트가 무한 로딩에 빠지지 않도록.
  const timeout = setTimeout(() => {
    send('error', { message: '60초를 넘겨서 중단했습니다. 다시 시도해주세요.' })
    res.end()
  }, 60_000)

  try {
    send('step', { index: 1, total: 4, label: '앱 설계' })
    const files = await generateApp(prompt, log)
    const html = files['index.html']!
    const title = extractTitle(html)
    send('title', { title })

    // Nosana 검수는 샌드박스 부팅과 병렬로. 실패해도 플로우를 막지 않는다.
    const reviewPromise = reviewApp(html, log).catch(() => null)

    send('step', { index: 2, total: 4, label: 'Daytona 샌드박스' })
    const { previewUrl } = await launchSandbox(files, log)

    send('step', { index: 3, total: 4, label: 'DNS 레코드 생성' })
    const slug = makeSlug(prompt)
    const url = await publish(slug, previewUrl, log)

    send('step', { index: 4, total: 4, label: '라이브' })
    const [review] = await Promise.allSettled([reviewPromise])
    const qr = await QRCode.toDataURL(url, { width: 480, margin: 1, color: { dark: '#0b0d10', light: '#ffffff' } })

    clearTimeout(timeout)
    send('done', {
      url,
      qr,
      title,
      previewUrl,
      elapsedMs: Date.now() - started,
      review: review.status === 'fulfilled' ? review.value : null,
    })
  } catch (err) {
    clearTimeout(timeout)
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ship]', err)
    send('error', { message })
  } finally {
    res.end()
  }
})

app.listen(PORT, () => {
  console.log(`\n  Ship → http://localhost:${PORT}\n`)
})
