import { Daytona } from '@daytona/sdk'
import { optional } from './env.js'

/**
 * Daytona 클라이언트.
 *
 * apiUrl 을 명시적으로 넘긴다 — .env 와 프로세스 환경 양쪽에 DAYTONA_API_URL 이
 * 있으면 SDK 가 어느 쪽인지 모르겠다며 거부한다.
 */
export function daytona(): Daytona {
  const apiKey = optional('DAYTONA_API_KEY')
  if (!apiKey) throw new Error('.env 의 DAYTONA_API_KEY 가 비어 있습니다.')

  return new Daytona({
    apiKey,
    apiUrl: optional('DAYTONA_API_URL', 'https://app.daytona.io/api'),
  })
}
