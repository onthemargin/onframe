import { defineConfig } from 'vite';

// Serve under the same base path used in production so absolute
// `/onframe/...` URLs in index.html/app.js/cloud.js resolve.
export default defineConfig({
  base: '/onframe/',
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
