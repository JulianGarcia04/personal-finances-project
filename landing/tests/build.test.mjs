// Runs against `dist/` after `astro build` with SITE_URL and PUBLIC_APP_URL set
// (see the `test` script): the point of this site is the static HTML crawlers read.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const SITE = process.env.SITE_URL
const APP = process.env.PUBLIC_APP_URL
const page = (path) => readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8')
const meta = (html, attr, name) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1]

test('build runs with the URLs the assertions use', () => {
  assert.ok(SITE && APP, 'SITE_URL and PUBLIC_APP_URL must be set')
})

test('landing content is in the static HTML, with no client JavaScript', () => {
  const html = page('index.html')
  assert.match(html, /Tus finanzas personales y las de pareja/)
  assert.match(html, /Gratis durante la beta/)
  assert.doesNotMatch(html, /<astro-island|<script type="module"/)
})

test('landing links signup and login to the app, and legal pages locally', () => {
  const html = page('index.html')
  assert.ok(html.includes(`href="${APP}/login?modo=registro"`))
  assert.ok(html.includes(`href="${APP}/login"`))
  assert.match(html, /href="\/terminos"/)
  assert.match(html, /href="\/privacidad"/)
})

test('every page has its own title, description, canonical URL and Open Graph tags', () => {
  const pages = [
    ['index.html', '/', /pareja/],
    ['terminos.html', '/terminos', /Términos y condiciones/],
    ['privacidad.html', '/privacidad', /Política de tratamiento de datos personales/]
  ]
  const titles = new Set()
  for (const [file, path, title] of pages) {
    const html = page(file)
    const pageTitle = html.match(/<title>([^<]*)<\/title>/)?.[1]
    assert.match(pageTitle, title, file)
    titles.add(pageTitle)
    assert.ok(meta(html, 'name', 'description'), `${file} description`)
    assert.ok(html.includes(`<link rel="canonical" href="${new URL(path, SITE).href}"`), `${file} canonical`)
    assert.equal(meta(html, 'property', 'og:url'), new URL(path, SITE).href, `${file} og:url`)
    assert.equal(meta(html, 'property', 'og:image'), new URL('/icon-512.png', SITE).href, `${file} og:image`)
    assert.equal(meta(html, 'property', 'og:title'), pageTitle, `${file} og:title`)
  }
  assert.equal(titles.size, pages.length)
})

test('legal pages render the shared documents with a way back', () => {
  const privacy = page('privacidad.html')
  assert.match(privacy, /Ley 1581 de 2012/)
  assert.match(privacy, /Superintendencia de Industria y Comercio/)
  assert.match(privacy, /<a href="\/"[^>]*>← Volver<\/a>/)
  assert.match(page('terminos.html'), /no constituye asesoría financiera/)
})

test('landing describes the app for search engines', () => {
  const jsonLd = page('index.html').match(/<script type="application\/ld\+json">([^<]*)<\/script>/)?.[1]
  const data = JSON.parse(jsonLd)
  assert.equal(data['@type'], 'SoftwareApplication')
  assert.equal(data.applicationCategory, 'FinanceApplication')
  assert.equal(data.offers.price, '0')
})

test('every page calls the product Lynor Finanzas, never Vault', () => {
  for (const file of ['index.html', 'terminos.html', 'privacidad.html']) {
    const html = page(file)
    assert.doesNotMatch(html, /\b(Vault|VAULT)\b/, file)
    assert.equal(meta(html, 'property', 'og:site_name'), 'Lynor Finanzas', file)
  }
  assert.match(page('index.html'), /<title>Lynor Finanzas \|/)
  assert.match(page('terminos.html'), /<title>[^<]* \| Lynor Finanzas<\/title>/)
  assert.match(page('privacidad.html'), /<title>[^<]* \| Lynor Finanzas<\/title>/)
  const jsonLd = page('index.html').match(/<script type="application\/ld\+json">([^<]*)<\/script>/)?.[1]
  assert.equal(JSON.parse(jsonLd).name, 'Lynor Finanzas')
})

test('sitemap and robots.txt point crawlers at every page', () => {
  assert.ok(existsSync(new URL('../dist/sitemap-index.xml', import.meta.url)))
  const sitemap = page('sitemap-0.xml')
  for (const path of ['/', '/terminos', '/privacidad']) {
    assert.ok(sitemap.includes(`<loc>${new URL(path, SITE).href}</loc>`), path)
  }
  assert.match(page('robots.txt'), new RegExp(`Sitemap: ${new URL('/sitemap-index.xml', SITE).href}`))
})
