import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api (including the SSE stream) to the backend so the
// frontend can use same-origin relative URLs and avoid CORS in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // SSE needs streaming; http-proxy handles this, just don't buffer.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('Connection', 'keep-alive'));
        },
      },
    },
  },
});
