import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Web-augmented search must never hit real search engines from the test
    // suite; web-search tests inject their own providers/env explicitly.
    env: {
      SWISS_SHOPPING_WEB_SEARCH: 'off',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/index.ts',
      ],
    },
    include: ['src/**/*.test.ts'],
  },
});
