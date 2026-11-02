import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The wallet libraries (Solana web3.js, WalletConnect) expect Node's Buffer and process.
    nodePolyfills({ include: ['buffer', 'process'], globals: { Buffer: true, process: true, global: true } }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: {
    // A CommonJS workspace package: pre-bundle it so the dev server can import it as ESM.
    include: ['@nexus/types'],
  },
  server: {
    port: 3000,
    proxy: {
      // Same as production, where nginx forwards /api to the NestJS API.
      '/api': { target: process.env.API_URL?.replace(/\/api$/, '') || 'http://localhost:4000', changeOrigin: true },
    },
  },
  preview: { port: 3000 },
});
