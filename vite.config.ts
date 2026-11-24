import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const TOWER = 'http://127.0.0.1:4870';

// The web app is served by the Tower in production (web-dist). In dev, Vite serves
// it and proxies /api + /ws to the Tower, whose dev-mode Origin allowlist includes
// this dev-server origin. The service worker precaches the shell but is NETWORK-ONLY
// for /api and never touches /ws (SPEC S14 — never cache authed/secret responses).
export default defineConfig({
  root: 'src/web',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false, // use the checked-in public/manifest.webmanifest
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/preview/],
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: 'NetworkOnly' },
          { urlPattern: /\/ws/, handler: 'NetworkOnly' },
          // /preview is the sandboxed artifact capability URL (SPEC-FILES §4): the SW must never
          // serve index.html into the frame nor cache artifact bytes (grants are short-lived).
          { urlPattern: /\/preview/, handler: 'NetworkOnly' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Trailing slash is load-bearing: a bare '/api' prefix also captures the frontend module
      // '/api.ts' (src/web/api.ts) and proxies it to the Tower, which returns HTML — the browser then
      // rejects it as a module script and the SPA never mounts. '/api/' matches every API route but not
      // the module.
      '/api/': { target: TOWER, changeOrigin: false },
      '/ws': { target: TOWER, ws: true, changeOrigin: false },
      // Sandboxed artifact preview (SPEC-FILES §4) — the iframe src is a relative /preview URL,
      // so in dev it must proxy to the Tower like /api does.
      '/preview': { target: TOWER, changeOrigin: false },
    },
  },
  build: {
    outDir: '../../web-dist',
    emptyOutDir: true,
  },
});
