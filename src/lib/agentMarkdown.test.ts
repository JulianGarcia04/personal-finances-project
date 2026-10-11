import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAgentMarkdown } from './agentMarkdown.ts'

test('returns empty string for empty input', () => {
  assert.equal(renderAgentMarkdown(''), '')
})

test('escapes raw HTML, including script tags', () => {
  const html = renderAgentMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)>')
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('escapes quotes so text can never break out of an attribute', () => {
  const html = renderAgentMarkdown(`"'`)
  assert.ok(html.includes('&quot;'))
  assert.ok(html.includes('&#39;'))
})

test('renders bold, italic and inline code', () => {
  const html = renderAgentMarkdown('**fuerte** y *suave* y `codigo`')
  assert.match(html, /<strong>fuerte<\/strong>/)
  assert.match(html, /<em>suave<\/em>/)
  assert.match(html, /<code[^>]*>codigo<\/code>/)
})

test('inline code content is not formatted further', () => {
  const html = renderAgentMarkdown('`**no**`')
  assert.ok(!html.includes('<strong>'))
  assert.match(html, /<code[^>]*>\*\*no\*\*<\/code>/)
})

test('does not italicize snake_case words or bare asterisks in amounts', () => {
  const html = renderAgentMarkdown('usa loan_payment y 2 * 3 * 4')
  assert.ok(!html.includes('<em>'))
})

test('renders headings h1-h3', () => {
  const html = renderAgentMarkdown('# Uno\n## Dos\n### Tres')
  assert.match(html, /<h3[^>]*>Uno<\/h3>/)
  assert.match(html, /<h4[^>]*>Dos<\/h4>/)
  assert.match(html, /<h5[^>]*>Tres<\/h5>/)
})

test('renders unordered and numbered lists', () => {
  const html = renderAgentMarkdown('- a\n- b\n\n1. uno\n2. **dos**')
  assert.match(html, /<ul[^>]*><li>a<\/li><li>b<\/li><\/ul>/)
  assert.match(html, /<ol[^>]*><li>uno<\/li><li><strong>dos<\/strong><\/li><\/ol>/)
})

test('numbered list keeps its start number', () => {
  const html = renderAgentMarkdown('3. tres\n4. cuatro')
  assert.match(html, /<ol[^>]*start="3"/)
})

test('renders a GFM pipe table inside a horizontal scroll container', () => {
  const md = '| Categoría | Monto |\n|---|---:|\n| Comida | $ 30.000 |\n| Ropa | $ 120.000 |'
  const html = renderAgentMarkdown(md)
  assert.match(html, /<div class="[^"]*overflow-x-auto[^"]*"><table/)
  assert.match(html, /<th[^>]*>Categoría<\/th>/)
  assert.match(html, /<th[^>]*text-right[^>]*>Monto<\/th>/)
  assert.match(html, /<td[^>]*>Comida<\/td>/)
  assert.match(html, /<td[^>]*text-right[^>]*>\$ 120.000<\/td>/)
  assert.equal((html.match(/<tr/g) || []).length, 3)
})

test('table cells cannot inject attributes or tags', () => {
  const md = '| a | b |\n|---|---|\n| " onmouseover="alert(1) | <b onclick=x>y</b> |'
  const html = renderAgentMarkdown(md)
  assert.ok(!html.includes('onmouseover="'))
  assert.ok(!html.includes('<b '))
  assert.ok(html.includes('&quot; onmouseover=&quot;alert(1)'))
})

test('pipes without a separator row stay as text', () => {
  const html = renderAgentMarkdown('a | b')
  assert.ok(!html.includes('<table'))
  assert.ok(html.includes('a | b'))
})

test('renders http(s) links with safe attributes', () => {
  const html = renderAgentMarkdown('[DIAN](https://www.dian.gov.co/a_b?x=1&y=2)')
  assert.match(
    html,
    /<a href="https:\/\/www\.dian\.gov\.co\/a_b\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"[^>]*>DIAN<\/a>/
  )
})

test('does not render javascript: or data: links', () => {
  const html = renderAgentMarkdown('[x](javascript:alert(1)) [y](data:text/html,hi) [z](JaVaScRiPt:alert(1))')
  assert.ok(!html.includes('<a '))
  assert.ok(!/href=/i.test(html))
})

test('link URL cannot break out of the href attribute', () => {
  const html = renderAgentMarkdown('[x](https://a.co/"onmouseover="alert(1))')
  assert.ok(!html.includes('"onmouseover="'))
})

test('paragraphs are separated and single newlines become <br>', () => {
  const html = renderAgentMarkdown('linea 1\nlinea 2\n\notro')
  assert.match(html, /<p>linea 1<br>linea 2<\/p><p>otro<\/p>/)
})

test('fenced code blocks are escaped and unformatted', () => {
  const html = renderAgentMarkdown('```\n<b>**x**</b>\n```')
  assert.match(html, /<pre[^>]*><code>&lt;b&gt;\*\*x\*\*&lt;\/b&gt;<\/code><\/pre>/)
})
