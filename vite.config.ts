import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'demo' ? '/MeterOak/' : '/',
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
  server: { proxy: mode === 'demo' ? undefined : { '/api': 'http://127.0.0.1:4491' } },
  preview: { proxy: mode === 'demo' ? undefined : { '/api': 'http://127.0.0.1:4491' } },
}));
