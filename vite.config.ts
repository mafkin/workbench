import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the UI runs on 7421 and proxies the API to the service on 7420.
export default defineConfig({
  plugins: [react()],
  // A local app: one ~550 kB bundle (React, zod, the icon name map) is fine.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    host: '127.0.0.1',
    port: 7421,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:7420' },
  },
})
