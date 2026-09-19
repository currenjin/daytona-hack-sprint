import { optional, required } from './env.js'
import type { Log } from './generate.js'

const DNSIMPLE_API = 'https://api.dnsimple.com/v2'

/** VPS 라우터에 slug → Daytona preview URL 매핑을 등록한다. */
async function registerRoute(slug: string, target: string, onLog: Log): Promise<void> {
  const routerUrl = optional('ROUTER_URL')
  if (!routerUrl) {
    onLog('ROUTER_URL 미설정 — 라우터 등록을 건너뜁니다')
    return
  }

  const res = await fetch(`${routerUrl.replace(/\/$/, '')}/_register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, target, secret: optional('ROUTER_SECRET') }),
  })

  if (!res.ok) {
    throw new Error(`라우터 등록 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  onLog(`라우터 등록 완료: ${slug}`)
}

/**
 * DNSimple API로 개별 A 레코드를 생성한다.
 *
 * 와일드카드 레코드가 이미 있으므로 기능상 필수는 아니다.
 * "에이전트가 실제로 DNS 레코드를 만든다"를 데모에서 보여주기 위한 것 —
 * 그리고 이게 이 프로젝트의 스폰서 통합 차별점이다.
 */
async function createDnsRecord(slug: string, onLog: Log): Promise<void> {
  const token = optional('DNSIMPLE_TOKEN')
  const account = optional('DNSIMPLE_ACCOUNT_ID')
  const zone = optional('DNSIMPLE_ZONE')
  const ip = optional('VPS_IP')

  if (!token || !account || !zone || !ip) {
    onLog('DNSimple 설정 미완료 — 레코드 생성을 건너뜁니다')
    return
  }

  const res = await fetch(`${DNSIMPLE_API}/${account}/zones/${zone}/records`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: `${slug}.ship`, type: 'A', content: ip, ttl: 60 }),
  })

  if (res.ok) {
    onLog(`DNS 레코드 생성: ${slug}.ship.${zone} → ${ip}`)
    return
  }

  // 이미 존재하는 레코드는 성공으로 친다.
  const body = await res.text()
  if (res.status === 400 || res.status === 409) {
    onLog(`DNS 레코드 이미 존재: ${slug}.ship.${zone}`)
    return
  }
  throw new Error(`DNSimple 레코드 생성 실패 (${res.status}): ${body.slice(0, 200)}`)
}

/** URL이 실제로 200을 반환할 때까지 대기 (최대 tries초) */
async function waitForLive(url: string, onLog: Log, tries = 12): Promise<boolean> {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (res.ok) return true
    } catch {
      // 전파 중 — 무시하고 재시도
    }
    onLog(`전파 대기... (${i}/${tries})`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/**
 * 라우터 등록 + DNS 레코드 생성 + 라이브 확인.
 * 최종 공개 URL을 반환한다. 설정이 불완전하면 preview URL로 폴백한다.
 */
export async function publish(slug: string, previewUrl: string, onLog: Log): Promise<string> {
  const zone = optional('DNSIMPLE_ZONE')
  if (!zone) {
    onLog('DNSIMPLE_ZONE 미설정 — Daytona preview URL을 그대로 사용합니다')
    return previewUrl
  }

  await registerRoute(slug, previewUrl, onLog)
  await createDnsRecord(slug, onLog)

  const publicUrl = `https://${slug}.ship.${zone}`
  const live = await waitForLive(publicUrl, onLog)
  if (!live) {
    onLog('도메인이 아직 응답하지 않습니다 — preview URL로 폴백합니다')
    return previewUrl
  }
  return publicUrl
}

/** 전날 검증용: DNSimple 토큰이 유효한지 + account ID 확인 */
export async function whoami(): Promise<unknown> {
  const token = required('DNSIMPLE_TOKEN')
  const res = await fetch(`${DNSIMPLE_API}/whoami`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`DNSimple whoami 실패 (${res.status})`)
  return res.json()
}
