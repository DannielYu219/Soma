import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the UI and the backend share one origin: Vite forwards API paths to the backend.
const backend = `http://127.0.0.1:${process.env.SOMA_BACKEND_PORT || 8787}`

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: backend },
      '/api': { target: backend },
      '/health': { target: backend },
    },
  },
})
