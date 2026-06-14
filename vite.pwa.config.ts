import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// PWA front-end build. Root is `pwa/`, but it imports the shared engine from
// `../src/engine`, so fs.allow lets the dev server reach outside the root.
// `base: './'` keeps asset URLs relative so the app works when served from a
// subpath (e.g. https://abs.example.com/gread/ — same-origin with ABS).
export default defineConfig({
  root: 'pwa',
  base: './',
  publicDir: 'public',
  build: {
    outDir: '../dist-pwa',
    emptyOutDir: true,
  },
  server: {
    fs: { allow: ['..'] },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'gread — speed reader',
        short_name: 'gread',
        description: 'RSVP speed-reader for your reading library',
        theme_color: '#15171c',
        background_color: '#15171c',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
});
