import Anthropic from '@anthropic-ai/sdk'

export type Log = (message: string) => void

const client = new Anthropic() // ANTHROPIC_API_KEY 환경변수 사용

const SYSTEM = `당신은 웹앱을 단일 HTML 파일로 만드는 엔지니어입니다.

출력 규칙 (반드시 지킬 것):
- 완성된 단일 HTML 문서 하나만 출력한다. 설명 문장, 마크다운 코드펜스 금지.
- 외부 CDN / 외부 폰트 / 외부 이미지 금지. CSS와 JS는 전부 인라인. 오프라인에서도 떠야 한다.
- 모바일 우선. 심사위원이 휴대폰으로 QR을 찍어서 본다. 터치 타겟은 44px 이상.
- 다크 테마. 배경 #0b0d10 계열, 본문 #e8eaed 계열, 포인트 컬러 하나만 골라서 일관되게.
- 첫 화면에서 바로 뭔가 동작해야 한다. 빈 상태 금지 — 그럴듯한 더미 데이터를 미리 채워 넣는다.
- 인터랙션이 최소 하나는 실제로 동작해야 한다 (클릭, 입력, 투표, 필터 등).
- <title> 을 반드시 넣는다.`

/** 사용자 요청 한 줄 → 단일 index.html */
export async function generateApp(userPrompt: string, onLog: Log): Promise<Record<string, string>> {
  onLog('앱 설계 중...')

  // 스트리밍: 긴 HTML 출력에서 HTTP 타임아웃을 피한다.
  const stream = client.messages.stream({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low' }, // 데모는 속도가 생명
    messages: [{ role: 'user', content: userPrompt }],
  })

  let ticks = 0
  stream.on('text', () => {
    if (++ticks % 40 === 0) onLog(`코드 생성 중... (${ticks * 8}자 내외)`)
  })

  const message = await stream.finalMessage()

  if (message.stop_reason === 'refusal') {
    throw new Error('모델이 이 요청을 거절했습니다. 다른 프롬프트로 시도하세요.')
  }

  let html = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()

  // 코드펜스가 섞여 오면 벗겨낸다.
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim()

  if (!/<html/i.test(html)) {
    throw new Error('생성된 결과가 HTML 문서가 아닙니다.')
  }

  onLog(`앱 완성 (${(html.length / 1024).toFixed(1)}KB)`)
  return { 'index.html': html }
}

/** <title> 추출 — 파비콘 생성과 로그 표시에 쓴다. */
export function extractTitle(html: string): string {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  return m?.[1]?.trim() || 'Untitled'
}
