import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: { tsconfig: 'tsconfig.build.json' },
  tsconfig: 'tsconfig.build.json',
  clean: true,
  target: 'esnext',
  external: ['bun:sqlite'], // Bun built-in — never bundle
  // `yaml` is a runtime dependency → tsup externalizes it automatically
});
