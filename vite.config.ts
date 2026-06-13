import { defineConfig } from 'vite';

// Milestone 1: just the standalone harness page at the repo root.
// (Extension bundling comes in a later milestone.)
export default defineConfig({
  root: '.',
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
