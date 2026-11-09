import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // Served from https://<user>.github.io/tool-tiny-images/, so every emitted
  // asset URL needs that prefix. Vercel serves from the domain root, where a
  // trailing-slash base is still resolved correctly.
  base: '/tool-tiny-images/',
  plugins: [wasm()],
  optimizeDeps: {
    exclude: ['@jsquash/jpeg', '@jsquash/oxipng', 'imagequant']
  }
});
