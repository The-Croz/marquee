import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs separately on 9797.
    proxy: { '/api': { target: 'http://localhost:9797', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
