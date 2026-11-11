// Builds the React window (src/ui) into src/renderer/ui/olive.js and olive.css, which index.html loads.
// One classic script, not a module: the page is a file:// page, and the audio engine is a plain script beside it.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  logLevel: 'warn',
  build: {
    outDir: '../renderer/ui',
    emptyOutDir: true,
    target: 'chrome130',
    cssCodeSplit: false,
    reportCompressedSize: false,
    lib: { entry: 'main.jsx', formats: ['iife'], name: 'OliveUI', fileName: () => 'olive.js', cssFileName: 'olive' }
  }
});
