import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = process.env.VIOLETDAGGER_HTTP_PORT ?? '4200';

// Vite 会给"浏览器↔Vite"的 WS 套接字挂 error 监听并原样 error 打印（vite/dist/.../proxy）：
// 浏览器刷新/关页/切走时这条连接常被 RST，于是刷出 `ws proxy socket error: read ECONNRESET`。
// 这属于 dev 噪音（不是后端或代码问题），这里只过滤这一类，其余错误照常打印。
const logger = createLogger();
const baseError = logger.error.bind(logger);
logger.error = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('ws proxy') && /ECONNRESET|EPIPE/.test(msg)) return;
  baseError(msg, options);
};

export default defineConfig({
  customLogger: logger,
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
