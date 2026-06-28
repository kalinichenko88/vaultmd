import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'esnext',
  external: ['bun:sqlite'], // Bun built-in — never bundle
  // `yaml` is a runtime dependency → tsup externalizes it automatically
});
