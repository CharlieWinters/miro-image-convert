import path from 'path';
import fs from 'fs';
import dns from 'dns';
import {defineConfig} from 'vite';

// https://vitejs.dev/config/server-options.html#server-host
dns.setDefaultResultOrder('verbatim');

// Every html file in the project root is an app surface, so make each one a
// build entry. Anything under dev/ is deliberately excluded.
const htmlEntries = fs
  .readdirSync('.')
  .filter((file) => path.extname(file) === '.html')
  .reduce((acc, file) => {
    acc[path.basename(file, '.html')] = path.resolve(__dirname, file);
    return acc;
  }, {});

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: htmlEntries,
      // Stable, unhashed filenames. Pages serves HTML with a ten minute
      // cache, and a deploy replaces the branch contents: with hashed names a
      // browser holding cached HTML asks for an asset the deploy just deleted,
      // 404s, and the app silently breaks. Stable names always resolve.
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: 3000,
    // Fail instead of quietly moving to the next free port. The manifest pins
    // sdkUri to localhost:3000, so a silent move means the board iframe loads
    // whatever else is on 3000 instead of this app.
    strictPort: true,
  },
});
