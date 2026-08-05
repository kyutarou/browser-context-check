import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .mjs so the extension's own modules can be imported and run as-is, without a TS build step
    // standing between the test and the code that actually ships.
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
    environment: 'node',
  },
});
