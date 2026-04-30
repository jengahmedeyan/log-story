import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
    'integrations/winston': 'src/integrations/winston.ts',
    'integrations/pino': 'src/integrations/pino.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: true,
  external: ['openai', '@anthropic-ai/sdk', '@google/generative-ai'],
});
