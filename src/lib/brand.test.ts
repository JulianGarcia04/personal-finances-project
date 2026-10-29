// The Lynor brand (S10): one symbol drawn from shared paths on every branded screen,
// in the favicon and in the PWA icons, with Sora as the display font.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LYNOR_MARK_PATHS } from './brand.ts'

const file = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)))
const read = (path: string) => file(path).toString('utf8')
// Width and height from the PNG IHDR chunk.
const pngSize = (path: string) => [file(path).readUInt32BE(16), file(path).readUInt32BE(20)]

test('the Lynor symbol replaces the V monogram on every branded screen', () => {
  const logo = read('../components/LynorLogo.vue')
  assert.match(logo, /LYNOR_MARK_PATHS/)
  assert.match(logo, /useId\(\)/, 'each instance gets its own gradient id')
  for (const [view, uses] of [['../views/Landing.vue', 1], ['../views/Login.vue', 1], ['../components/Sidebar.vue', 2]] as const) {
    const source = read(view)
    assert.doesNotMatch(source, />V<\/span>/, view)
    assert.equal(source.match(/<LynorLogo\b/g)?.length, uses, view)
  }
})

test('the favicon and the PWA icons are drawn from the Lynor symbol', () => {
  for (const svg of ['../../public/favicon.svg', '../../landing/public/favicon.svg']) {
    for (const d of LYNOR_MARK_PATHS) assert.ok(read(svg).includes(`d="${d}"`), svg)
  }
  assert.deepEqual(pngSize('../../public/apple-touch-icon.png'), [180, 180])
  assert.deepEqual(pngSize('../../public/icon-192.png'), [192, 192])
  assert.deepEqual(pngSize('../../public/icon-512.png'), [512, 512])
  assert.deepEqual(pngSize('../../public/icon-maskable-512.png'), [512, 512])
  for (const icon of ['apple-touch-icon.png', 'icon-512.png']) {
    assert.ok(file(`../../landing/public/${icon}`).equals(file(`../../public/${icon}`)), `landing ships the app's ${icon}`)
  }
  const manifest = JSON.parse(read('../../public/manifest.webmanifest'))
  assert.ok(manifest.icons.some((icon: { src: string; purpose: string }) => icon.src === '/icon-maskable-512.png' && icon.purpose === 'maskable'))
})

test('Sora is the display font', () => {
  assert.match(read('../style.css'), /--font-display: "Sora", sans-serif;/)
  assert.match(read('../../index.html'), /family=Sora:wght@/)
  for (const source of ['../style.css', '../../index.html', '../../tailwind.config.js']) {
    assert.doesNotMatch(read(source), /Outfit/, source)
  }
})
