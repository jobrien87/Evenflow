import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Plain readFileSync+JSON.parse rather than an ESM JSON import assertion
// -- portable across whatever Node version actually runs the build,
// rather than depending on a specific Node's import-attribute support.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// Real build identity, baked in at build time -- never a hand-maintained
// counter. package.json's version is the one piece a release bumps by
// hand; the git short SHA makes every single build unambiguous even
// between version bumps, so "what's actually live" is always answerable
// from the running app alone (Sidebar/MobileDrawer render this).
function gitShortSha() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(gitShortSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
