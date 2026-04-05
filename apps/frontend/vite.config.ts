import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4073, // "wOrK" → w(4)o(0)r(7)k(3)
  },
})
