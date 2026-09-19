const WORDS = [
  'amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'haven',
  'indigo', 'juniper', 'kelp', 'lumen', 'maple', 'nimbus', 'onyx', 'pine',
  'quartz', 'river', 'slate', 'tide', 'umber', 'vale', 'willow', 'zephyr',
]

/**
 * 프롬프트에서 URL 슬러그를 만든다.
 * 한글/이모지만 있으면 랜덤 영단어 + 숫자로 떨어진다 (DNS 라벨은 ASCII 여야 하므로).
 */
export function makeSlug(prompt: string): string {
  const ascii = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')

  const suffix = Math.floor(Math.random() * 900 + 100)
  if (ascii.length >= 3) return `${ascii}-${suffix}`

  const word = WORDS[Math.floor(Math.random() * WORDS.length)]
  return `${word}-${suffix}`
}
