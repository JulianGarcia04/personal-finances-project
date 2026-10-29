// What a deploy relies on: production origins without any environment, and the
// Firebase Hosting targets that serve the landing next to the app.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const LANDING = 'https://finances.lynor.cloud'
const APP = 'https://app.finances.lynor.cloud'

test('a build without SITE_URL or PUBLIC_APP_URL uses the production origins', (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'landing-build-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const env = { ...process.env }
  delete env.SITE_URL
  delete env.PUBLIC_APP_URL

  const astro = fileURLToPath(new URL('../node_modules/.bin/astro', import.meta.url))
  const build = spawnSync(astro, ['build', '--outDir', outDir], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    encoding: 'utf8'
  })
  assert.equal(build.status, 0, build.stderr || build.stdout)

  const html = readFileSync(join(outDir, 'index.html'), 'utf8')
  assert.ok(html.includes(`<link rel="canonical" href="${LANDING}/"`))
  assert.ok(html.includes(`href="${APP}/login?modo=registro"`))
  assert.ok(html.includes(`href="${APP}/login"`))
  assert.ok(readFileSync(join(outDir, 'sitemap-0.xml'), 'utf8').includes(`<loc>${LANDING}/terminos</loc>`))
})

test('Firebase Hosting serves the app and the landing as separate targets', () => {
  const firebase = JSON.parse(readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'))
  const site = (target) => firebase.hosting.find((entry) => entry.target === target)

  const app = site('app')
  assert.equal(app.public, 'dist')
  assert.deepEqual(app.rewrites, [{ source: '**', destination: '/index.html' }])

  const landing = site('landing')
  assert.equal(landing.public, 'landing/dist')
  assert.equal(landing.cleanUrls, true)
  assert.equal(landing.trailingSlash, false)
  assert.equal(landing.rewrites, undefined, 'missing pages answer 404, not the home page')
  assert.deepEqual(landing.predeploy, ['npm run landing:build'])
})
