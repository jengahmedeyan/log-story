#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, statSync, createReadStream } from 'fs';
import { LogStory } from '../index.js';
import type { LogStoryConfig, OutputFormat, GroupingConfig, AIProviderName } from '../types/index.js';

function detectProviderFromApiKey(apiKey: string | undefined, defaultProvider: AIProviderName = 'openai'): AIProviderName {
  if (!apiKey) return 'local';

  const trimmedKey = apiKey.trim();

  if (trimmedKey.startsWith('sk-ant-')) return 'anthropic';
  if (trimmedKey.startsWith('AIza')) return 'gemini';
  if (trimmedKey.startsWith('sk-')) return 'openai';

  return defaultProvider;
}

const program = new Command();

program
  .name('log-story')
  .description('Transform raw logs into human-readable narratives and actionable insights')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze logs and generate stories')
  .argument('[file]', 'Log file to analyze (or pipe via stdin)')
  .option('-f, --format <format>', 'Output format: cli, json, timeline', 'cli')
  .option('--ai-provider <provider>', 'AI provider: openai, anthropic, gemini', 'openai')
  .option('--api-key <key>', 'API key (or set LOG_STORY_API_KEY)')
  .option('--no-ai', 'Run without AI (template-based only)')
  .option('--group-by <strategy>', 'Grouping: auto, request, time', 'auto')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (file: string | undefined, options: any) => {
    const apiKey = options.apiKey ?? process.env.LOG_STORY_API_KEY;
    const provider = detectProviderFromApiKey(apiKey, options.aiProvider);

    const config: LogStoryConfig = {
      ai: options.ai === false ? undefined : {
        provider,
        apiKey,
      },
      grouping: buildGroupingConfig(options.groupBy),
      output: {
        format: options.format as OutputFormat,
        verbosity: options.verbose ? 'detailed' : 'normal',
      },
    };

    let input: string;
    if (file) {
      const fileSize = statSync(file).size;
      const MAX_SYNC_SIZE = 50 * 1024 * 1024; // 50MB

      if (fileSize > MAX_SYNC_SIZE) {
        // Stream large files to avoid OOM (Out of Memory)
        const logStory = new LogStory(config);
        const stream = logStory.createStream();
        const stories: any[] = [];
        const insights: any[] = [];
        let stats: any = {};

        stream.on('story', (story) => stories.push(story));
        stream.on('insight', (insight) => insights.push(insight));

        await new Promise<void>((resolve, reject) => {
          stream.on('done', (s) => { stats = s; resolve(); });
          stream.on('error', reject);
          createReadStream(file).pipe(stream);
        });

        const output = logStory.format({
          storyUnits: stories,
          insights,
          systemSummary: `${stories.length} stories from streaming analysis.`,
          events: [],
          stats: { ...stats, storiesGenerated: stories.length },
        });
        console.log(output);
        return;
      }

      input = readFileSync(file, 'utf-8');
    } else {
      input = await readStdin();
    }

    if (!input.trim()) {
      console.error('No log input provided. Pass a file or pipe via stdin.');
      process.exit(1);
    }

    const logStory = new LogStory(config);
    const result = await logStory.analyze(input);
    const output = logStory.format(result);
    console.log(output);
  });

program
  .command('query')
  .description('Ask a question about your logs')
  .argument('<question>', 'Natural language question')
  .option('--context <file>', 'Log file for context')
  .option('--api-key <key>', 'API key (or set LOG_STORY_API_KEY)')
  .option('--ai-provider <provider>', 'AI provider: openai, anthropic, gemini', 'openai')
  .action(async (question: string, options: any) => {
    const apiKey = options.apiKey ?? process.env.LOG_STORY_API_KEY;
    const provider = detectProviderFromApiKey(apiKey, options.aiProvider);

    let input: string;
    if (options.context) {
      input = readFileSync(options.context, 'utf-8');
    } else {
      input = await readStdin();
    }

    if (!input.trim()) {
      console.error('No log context provided. Use --context <file> or pipe via stdin.');
      process.exit(1);
    }

    const logStory = new LogStory({
      ai: { provider, apiKey },
    });

    try {
      const result = await logStory.analyze(input);
      const answer = await logStory.query(question, result);
      console.log(answer);
    } catch (err: any) {
      if (err.status === 401 || err.type === 'authentication_error') {
        console.error(`Authentication failed. Check your ${provider} API key.`);
      } else if (err.status === 429) {
        console.error(`Rate limit exceeded for ${provider}. Wait and retry, or check your plan's quota.`);
      } else {
        console.error(`AI provider error (${provider}): ${err.message ?? err}`);
      }
      process.exit(1);
    }
  });

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', (err) => reject(err));
  });
}

function buildGroupingConfig(strategy: string): GroupingConfig | undefined {
  switch (strategy) {
    case 'request':
      return { fields: ['requestId', 'traceId'] };
    case 'time':
      return { fields: [] }; // No ID fields → forces time-based grouping only
    case 'user':
      return { fields: ['userId', 'sessionId'] };
    case 'auto':
    default:
      return undefined;
  }
}

program.parse();
