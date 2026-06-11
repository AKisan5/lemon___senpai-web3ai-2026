import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // ブラウザ → Vite → Obsidian Local REST API（HTTPS）に中継する。
      // secure: false で自己署名証明書を無視するため、ブラウザ側で証明書を
      // 信頼させる必要がなくなる。
      '/obsidian': {
        target: 'https://127.0.0.1:27124',
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/obsidian/, ''),
      },
    },
  },
})
