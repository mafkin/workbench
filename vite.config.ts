import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the UI runs on 7421 and proxies the API to the service on 7420.
export default defineConfig({
  plugins: [react()],
  // A local app: a ~720 kB main bundle (React, zod, the icon name map, Markdown) is fine.
  // The note editor (CodeMirror, ~510 kB) is its own chunk, loaded on first Edit.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    host: '127.0.0.1',
    port: 7421,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:7420' },
  },
})
