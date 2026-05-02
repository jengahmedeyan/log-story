#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, statSync, createReadStream, existsSync, watchFile, openSync, readSync, closeSync } from 'fs';
import { resolve } from 'path';
import { LogStory } from '../index.js';
import type { LogStoryConfig, OutputFormat, GroupingConfig, AIProviderName, FilterConfig, LogLevel } from '../types/index.js';

async function createSpinner(text: string) {
  const { default: ora } = await import('ora');
  return ora({ text, spinner: 'dots' }).start();
}

const CONFIG_FILE_NAMES = ['.logstoryrc.json', 'logstory.config.json'];

function loadConfigFile(): Partial<LogStoryConfig> | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const filePath = resolve(process.cwd(), name);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as Partial<LogStoryConfig>;
      } catch {
        // Invalid config file — skip silently
      }
    }
  }
  return undefined;
}

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
  .option('--no-ai', 'Run without AI (template-based only)')
  .option('--group-by <strategy>', 'Grouping: auto, request, time', 'auto')
  .option('--level <levels>', 'Filter by log level (comma-separated: info,warn,error)')
  .option('--after <datetime>', 'Include only entries after this time (ISO 8601)')
  .option('--before <datetime>', 'Include only entries before this time (ISO 8601)')
  .option('--user <id>', 'Filter to entries for a specific user ID')
  .option('--request-id <id>', 'Filter to entries for a specific request/trace ID')
  .option('--debug-parse', 'Write unparsed lines to stderr with failure reason')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (file: string | undefined, options: any) => {
    // Set debug parse env var if flag is present
    if (options.debugParse) {
      process.env.LOG_STORY_DEBUG_PARSE = '1';
    }
    const fileConfig = loadConfigFile();
    const apiKey = process.env.LOG_STORY_API_KEY;
    const provider = detectProviderFromApiKey(apiKey, options.aiProvider);

    const config: LogStoryConfig = {
      ...fileConfig,
      ai: options.ai === false ? undefined : {
        ...fileConfig?.ai,
        provider,
        apiKey,
      },
      grouping: buildGroupingConfig(options.groupBy) ?? fileConfig?.grouping,
      output: {
        ...fileConfig?.output,
        format: options.format as OutputFormat,
        verbosity: options.verbose ? 'detailed' : 'normal',
      },
      filter: buildFilterConfig(options) ?? fileConfig?.filter,
    };

    let input: string;
    if (file) {
      const fileSize = statSync(file).size;
      const MAX_SYNC_SIZE = 50 * 1024 * 1024; // 50MB

      if (fileSize > MAX_SYNC_SIZE) {
        // Stream large files to avoid OOM (Out of Memory)
        const spinner = await createSpinner('Streaming large log file...');
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

        spinner.succeed(`Streaming complete — ${stories.length} stories found`);

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

    const spinner = await createSpinner('Analyzing logs...');
    const logStory = new LogStory(config);
    try {
      const result = await logStory.analyze(input);
      spinner.succeed(`Analysis complete — ${result.storyUnits.length} stories found`);
      const output = logStory.format(result);
      console.log(output);
    } catch (err: any) {
      if (err.code === 'UNRECOGNISED_FORMAT') {
        spinner.fail('Log format not recognised');
        console.error(`\n${err.message}`);
        if (options.debugParse && err.unmatchedSample?.length) {
          console.error(`\nUnmatched lines:`);
          for (const line of err.unmatchedSample) {
            console.error(`  ${line}`);
          }
        }
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command('query')
  .description('Ask a question about your logs')
  .argument('<question>', 'Natural language question')
  .option('--context <file>', 'Log file for context')
  .option('--ai-provider <provider>', 'AI provider: openai, anthropic, gemini', 'openai')
  .action(async (question: string, options: any) => {
    const apiKey = process.env.LOG_STORY_API_KEY;
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

function buildFilterConfig(options: any): FilterConfig | undefined {
  const filter: FilterConfig = {};
  let hasFilter = false;

  if (options.level) {
    filter.levels = options.level.split(',').map((l: string) => l.trim().toLowerCase()) as LogLevel[];
    hasFilter = true;
  }
  if (options.after) {
    const d = new Date(options.after);
    if (!isNaN(d.getTime())) { filter.after = d; hasFilter = true; }
  }
  if (options.before) {
    const d = new Date(options.before);
    if (!isNaN(d.getTime())) { filter.before = d; hasFilter = true; }
  }
  if (options.user) {
    filter.userId = options.user;
    hasFilter = true;
  }
  if (options.requestId) {
    filter.requestId = options.requestId;
    hasFilter = true;
  }

  return hasFilter ? filter : undefined;
}

program
  .command('watch')
  .description('Watch a log file and analyze new entries continuously')
  .argument('<file>', 'Log file to watch')
  .option('-f, --format <format>', 'Output format: cli, json, timeline', 'cli')
  .option('--ai-provider <provider>', 'AI provider: openai, anthropic, gemini', 'openai')
  .option('--no-ai', 'Run without AI (template-based only)')
  .option('--group-by <strategy>', 'Grouping: auto, request, time', 'auto')
  .option('--level <levels>', 'Filter by log level (comma-separated: info,warn,error)')
  .option('--user <id>', 'Filter to entries for a specific user ID')
  .option('--interval <ms>', 'Polling interval in milliseconds', '1000')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (file: string, options: any) => {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }

    const fileConfig = loadConfigFile();
    const apiKey = process.env.LOG_STORY_API_KEY;
    const provider = detectProviderFromApiKey(apiKey, options.aiProvider);

    const config: LogStoryConfig = {
      ...fileConfig,
      ai: options.ai === false ? undefined : {
        ...fileConfig?.ai,
        provider,
        apiKey,
      },
      grouping: buildGroupingConfig(options.groupBy) ?? fileConfig?.grouping,
      output: {
        ...fileConfig?.output,
        format: options.format as OutputFormat,
        verbosity: options.verbose ? 'detailed' : 'normal',
      },
      filter: buildFilterConfig(options) ?? fileConfig?.filter,
    };

    const interval = Math.max(500, parseInt(options.interval, 10) || 1000);
    let lastSize = statSync(file).size;
    let processing = false;

    const logStory = new LogStory(config);

    console.log(`Watching ${file} (polling every ${interval}ms). Press Ctrl+C to stop.\n`);

    // Initial analysis of existing content
    const initialContent = readFileSync(file, 'utf-8');
    if (initialContent.trim()) {
      const result = await logStory.analyze(initialContent);
      const output = logStory.format(result);
      console.log(output);
    }

    watchFile(file, { interval }, async () => {
      if (processing) return;

      let currentSize: number;
      try {
        currentSize = statSync(file).size;
      } catch {
        return; // File may have been deleted
      }

      if (currentSize <= lastSize) {
        if (currentSize < lastSize) lastSize = 0; // File was truncated — reset
        else return; // No new data
      }

      processing = true;
      try {
        // Read only new content from the file
        const fd = openSync(file, 'r');
        const buffer = Buffer.alloc(currentSize - lastSize);
        readSync(fd, buffer, 0, buffer.length, lastSize);
        closeSync(fd);

        const newContent = buffer.toString('utf-8');
        lastSize = currentSize;

        if (!newContent.trim()) return;

        const result = await logStory.analyze(newContent);
        if (result.storyUnits.length > 0) {
          const output = logStory.format(result);
          console.log(`\n--- New activity detected (${new Date().toLocaleTimeString()}) ---`);
          console.log(output);
        }
      } catch (err: any) {
        if (process.env.LOG_STORY_DEBUG) {
          console.error(`[log-story] Watch error:`, err.message);
        }
      } finally {
        processing = false;
      }
    });

    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('\nStopping watch...');
      process.exit(0);
    });
  });

program.parse();
