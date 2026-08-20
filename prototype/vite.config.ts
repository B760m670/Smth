import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Bound to every interface so a second machine on the LAN can join the
    // session — two browser tabs prove the protocol, two machines prove the
    // clock sync.
    host: true
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
