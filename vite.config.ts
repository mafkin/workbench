import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the UI runs on 7421 and proxies the API and chat sockets to the service on 7420.
export default defineConfig({
  plugins: [react()],
  // A local app: a ~720 kB main bundle (React, zod, the icon name map, Markdown) is fine.
  // The note editor (CodeMirror, ~510 kB) and the chat terminal (xterm, ~340 kB) are
  // their own chunks, loaded on first use.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    host: '127.0.0.1',
    port: 7421,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:7420', '/pty': { target: 'ws://127.0.0.1:7420', ws: true } },
  },
})
