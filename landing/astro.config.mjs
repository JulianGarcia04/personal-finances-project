import { fileURLToPath } from 'node:url'
import { defineConfig, envField } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import vue from '@astrojs/vue'
import tailwindcss from '@tailwindcss/vite'

// Production origins. SITE_URL and PUBLIC_APP_URL override them (previews, build tests).
const site = process.env.SITE_URL || 'https://finances.lynor.cloud'

export default defineConfig({
  // Canonical URLs, Open Graph and the sitemap are built from it.
  site,
  // /terminos is served from terminos.html, so canonical URLs and the sitemap agree.
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [vue(), sitemap()],
  env: {
    schema: {
      // Where signup and login links send visitors.
      PUBLIC_APP_URL: envField.string({
        context: 'client',
        access: 'public',
        url: true,
        default: 'https://app.finances.lynor.cloud'
      })
    }
  },
  vite: {
    plugins: [tailwindcss()],
    // The landing renders the app's own components and legal content.
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }
  }
})
