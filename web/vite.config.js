import { defineConfig } from 'vite';

// Base path the built app is served under. Defaults to `/onframe/` (the path
// used in the app.gyatso.me monorepo); override with VITE_BASE for a standalone
// deploy at a different path or root (e.g. VITE_BASE=/ for a dedicated domain).
export default defineConfig({
  base: process.env.VITE_BASE || '/onframe/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      // Forward cloud analysis API calls to the Express backend.
      '/onframe/api': {
        target: 'http://127.0.0.1:3004',
        changeOrigin: false,
      },
    },
  },
});
