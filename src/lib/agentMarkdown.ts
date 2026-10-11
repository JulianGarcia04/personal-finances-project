// Minimal, XSS-safe Markdown renderer for the AI advisor chat.
// Safety model: the whole input is HTML-escaped first; every tag emitted afterwards
// is produced by this module with fixed attributes. Model text never reaches the
// output unescaped, and links are limited to http(s) URLs.

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// Placeholder delimiter for already-rendered inline fragments (code spans, links).
// NUL is stripped from the input, so model text can never forge a placeholder.
const MARK = '\u0000'

const renderInline = (escaped: string): string => {
  const slots: string[] = []
  const stash = (html: string) => `${MARK}${slots.push(html) - 1}${MARK}`

  let out = escaped
    .replace(/`([^`\n]+)`/g, (_, code: string) => stash(`<code class="md-code">${code}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/gi, (_, label: string, url: string) =>
      stash(`<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`)
    )

  out = out
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?![\s_])([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>')

  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i: string) => slots[Number(i)])
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^\s*(\d{1,9})[.)]\s+(.*)$/
const FENCE = /^\s*```/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const splitRow = (line: string): string[] => {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map(cell => cell.trim())
}

type Align = 'left' | 'right' | 'center' | null

const alignOf = (spec: string): Align => {
  const left = spec.startsWith(':')
  const right = spec.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

const alignClass = (align: Align): string =>
  align === 'right' ? ' class="text-right"' : align === 'center' ? ' class="text-center"' : ''

const isTableStart = (lines: string[], i: number): boolean =>
  i + 1 < lines.length &&
  lines[i].includes('|') &&
  lines[i + 1].includes('|') &&
  TABLE_SEPARATOR.test(lines[i + 1])

const renderTable = (header: string, separator: string, body: string[]): string => {
  const headers = splitRow(header)
  const aligns = splitRow(separator).map(alignOf)
  const cell = (tag: 'th' | 'td', content: string, col: number) =>
    `<${tag}${alignClass(aligns[col] ?? null)}>${renderInline(content)}</${tag}>`

  const head = `<tr>${headers.map((h, c) => cell('th', h, c)).join('')}</tr>`
  const rows = body
    .map(line => {
      const cells = splitRow(line)
      return `<tr>${headers.map((_, c) => cell('td', cells[c] ?? '', c)).join('')}</tr>`
    })
    .join('')
  return `<div class="md-table-wrap overflow-x-auto"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
}

export const renderAgentMarkdown = (text: string): string => {
  if (!text) return ''
  const lines = escapeHtml(text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n')).split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`)
    paragraph = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      flushParagraph()
      i++
      continue
    }

    if (FENCE.test(line)) {
      flushParagraph()
      const code: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++])
      i++ // closing fence (or end of input)
      blocks.push(`<pre class="md-pre"><code>${code.join('\n')}</code></pre>`)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      const level = Math.min(heading[1].length + 2, 5)
      blocks.push(`<h${level} class="md-heading">${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }

    if (HR.test(line)) {
      flushParagraph()
      blocks.push('<hr class="md-hr">')
      i++
      continue
    }

    if (isTableStart(lines, i)) {
      flushParagraph()
      const header = lines[i]
      const separator = lines[i + 1]
      const body: string[] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) body.push(lines[i++])
      blocks.push(renderTable(header, separator, body))
      continue
    }

    if (UL.test(line) || OL.test(line)) {
      flushParagraph()
      const ordered = !UL.test(line)
      const pattern = ordered ? OL : UL
      const start = ordered ? Number(OL.exec(line)![1]) : 1
      const items: string[] = []
      while (i < lines.length && pattern.test(lines[i]) && (ordered || !HR.test(lines[i]))) {
        const match = pattern.exec(lines[i])!
        items.push(`<li>${renderInline(ordered ? match[2] : match[1])}</li>`)
        i++
      }
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : ''
      blocks.push(
        ordered
          ? `<ol class="md-ol"${startAttr}>${items.join('')}</ol>`
          : `<ul class="md-ul">${items.join('')}</ul>`
      )
      continue
    }

    paragraph.push(line)
    i++
  }
  flushParagraph()
  return blocks.join('')
}
