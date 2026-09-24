import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const proxy = { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: true } };
export default defineConfig({ plugins: [react()], server: { proxy, host: '127.0.0.1', port: 5174, strictPort: true }, preview: { proxy, host: '127.0.0.1', port: 5174, strictPort: true }, build: { sourcemap: false } });
