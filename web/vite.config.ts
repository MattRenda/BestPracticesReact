import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// The Sprout API runs on :4317 (see /server). Vite proxies /api to it in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
})
