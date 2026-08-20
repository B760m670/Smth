import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the same build works served from the game server
  // at "/", from GitHub Pages under "/Smth/", or opened straight off disk.
  // A build that only works at the root is a build that cannot be put on a
  // static host without a rewrite rule, which is the opposite of the point.
  base: './',
  server: {
    port: 5173,
    // Bound to every interface so a phone on the same wifi can open it — two
    // browser tabs prove the protocol, two devices prove the clock sync.
    host: true
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
