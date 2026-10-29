import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import vue from '@astrojs/vue'
import tailwindcss from '@tailwindcss/vite'

// Public origin of this site, for canonical URLs, Open Graph and the sitemap.
// Set it on every production build: without it those tags are left out.
const site = process.env.SITE_URL

export default defineConfig({
  site,
  // /terminos is served from terminos.html, so canonical URLs and the sitemap agree.
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [vue(), ...(site ? [sitemap()] : [])],
  vite: {
    plugins: [tailwindcss()],
    // The landing renders the app's own components and legal content.
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }
  }
})
