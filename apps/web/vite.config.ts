import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const upstream = 'http://localhost:3000';
const forwardedProxy = {
  target: upstream,
  changeOrigin: false,
  xfwd: true,
} as const;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Secret Santa Games',
        short_name: 'Santa Games',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#b91c1c',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      // Static assets only: no runtime caching of API/socket/state responses (privacy, ADR-0002).
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,ico}'],
        runtimeCaching: [],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//, /^\/health/],
      },
    }),
  ],
  server: {
    allowedHosts: ['.ngrok-free.app', '.ngrok.io'],
    fs: { allow: ['../..'] }, // doc/legal/*.md is bundled as static pages
    proxy: {
      '/api': { ...forwardedProxy },
      '/media': { ...forwardedProxy },
      '/health': { ...forwardedProxy },
      '/socket.io': { ...forwardedProxy, ws: true },
    },
  },
  preview: {
    allowedHosts: ['.ngrok-free.app', '.ngrok.io'],
  },
});
