import 'dotenv/config'

/** 없으면 즉시 죽는다. 데모 중에 undefined 때문에 헤매는 것보다 낫다. */
export function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`환경변수 ${name} 가 비어 있습니다. .env 를 확인하세요 (.env.example 참고)`)
  return v
}

export function optional(name: string, fallback = ''): string {
  return process.env[name] || fallback
}

export const PORT = Number(optional('PORT', '5173'))
