import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'esnext',
  tsconfig: 'tsconfig.build.json',
  external: ['bun:sqlite'],
});
