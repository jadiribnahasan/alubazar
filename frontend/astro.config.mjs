import { defineConfig } from 'astro/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  site: 'http://localhost:4321',
  vite: {
    server: {
      proxy: {
        '/web': {
          target: process.env.PUBLIC_ODOO_PROXY_TARGET || 'http://localhost:8070',
          changeOrigin: true
        },
        '/bn': {
          target: process.env.PUBLIC_ODOO_PROXY_TARGET || 'http://localhost:8070',
          changeOrigin: true
        },
        '/report': {
          target: process.env.PUBLIC_ODOO_PROXY_TARGET || 'http://localhost:8070',
          changeOrigin: true
        }
      }
    },
    plugins: [
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        manifest: {
          name: 'হিসাব খাতা',
          short_name: 'হিসাব',
          description: 'সহজ ইনভয়েস ও মজুত ব্যবস্থা',
          lang: 'bn',
          // Not '/': an installed app relaunched at the marketing page looks
          // like the shop's data vanished after the camera handed control back.
          start_url: '/app',
          id: '/app',
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: '#0f766e',
          icons: [
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
          ]
        },
        workbox: {
          // No navigateFallback on purpose. With one, the service worker answers
          // *every* navigation with a single page, so any reload of /app is
          // served the homepage HTML. Astro emits an index.html per route and
          // globPatterns precaches them all, so each path already resolves to
          // its own page (PrecacheRoute rewrites /app -> /app/index.html).
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}']
        }
      })
    ]
  }
});
