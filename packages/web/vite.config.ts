import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = process.env.VIOLETDAGGER_HTTP_PORT ?? '4200';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
