import type {
  LogStoryConfig,
  AnalysisResult,
  AIProvider,
  LogEvent,
  LogEntry,
  StoryUnit,
  FilterConfig,
} from './types/index.js';
import { parse, parseJSON, checkFormatConfidence } from './parser/index.js';
import { redactPII } from './parser/redaction.js';
import { groupEntries } from './grouping/index.js';
import { extractEvents } from './extraction/index.js';
import { buildStoryUnits } from './causality/index.js';
import { generateInsights, generateSystemSummary } from './insights/index.js';
import { format } from './output/index.js';
import { createAnalysisStream, type LogStoryStream } from './streaming/index.js';

function applyFilter(entries: LogEntry[], filter?: FilterConfig): LogEntry[] {
  if (!filter) return entries;
  let result = entries;
  if (filter.levels && filter.levels.length > 0) {
    result = result.filter(e => filter.levels!.includes(e.level));
  }
  if (filter.after) {
    const after = filter.after.getTime();
    result = result.filter(e => e.timestamp.getTime() >= after);
  }
  if (filter.before) {
    const before = filter.before.getTime();
    result = result.filter(e => e.timestamp.getTime() <= before);
  }
  if (filter.userId) {
    result = result.filter(e => e.userId === filter.userId);
  }
  if (filter.requestId) {
    result = result.filter(e => e.requestId === filter.requestId || e.traceId === filter.requestId);
  }
  return result;
}

const DEFAULT_MAX_INPUT_SIZE = 100 * 1024 * 1024; // 100MB

export class LogStory {
  private config: LogStoryConfig;

  constructor(config: LogStoryConfig = {}) {
    this.config = config;
  }

  private validateInputSize(input: string): void {
    const maxSize = this.config.maxInputSize ?? DEFAULT_MAX_INPUT_SIZE;
    const size = Buffer.byteLength(input, 'utf-8');
    if (size > maxSize) {
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      const maxMB = (maxSize / (1024 * 1024)).toFixed(1);
      throw new Error(
        `Input size (${sizeMB}MB) exceeds maximum (${maxMB}MB). ` +
        `Use streaming for large files, or increase maxInputSize in config.`
      );
    }
  }

  private applyRedaction(entries: LogEntry[]): LogEntry[] {
    const redactionConfig = this.config.redaction;
    if (!redactionConfig?.enabled) return entries;

    return entries.map(entry => ({
      ...entry,
      message: redactPII(entry.message, redactionConfig),
      raw: redactPII(entry.raw, redactionConfig),
    }));
  }

  private async enhanceWithAI(storyUnits: StoryUnit[]): Promise<{ aiCallsMade: number; estimatedCost: number }> {
    let aiCallsMade = 0;
    let estimatedCost = 0;

    if (!this.config.ai?.apiKey) return { aiCallsMade, estimatedCost };

    const { getProvider } = await import('./ai/index.js');
    const providerName = this.config.ai.provider ?? 'openai';

    try {
      const provider = await getProvider(providerName, this.config.ai.apiKey, this.config.ai.model);
      const redactionConfig = this.config.redaction;
      const concurrency = 5;

      // Process story units in parallel batches
      for (let i = 0; i < storyUnits.length; i += concurrency) {
        const batch = storyUnits.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(async (unit) => {
            const primaryEvent = unit.events[0];
            if (!primaryEvent) return;

            const combinedEvent: LogEvent = {
              ...primaryEvent,
              entries: unit.events.flatMap((e) => e.entries),
              actions: unit.events.flatMap((e) => e.actions),
              startTime: unit.startTime,
              endTime: unit.endTime,
              duration: unit.duration,
              outcome: unit.outcome,
            };

            unit.narrative = await provider.generateNarrative(combinedEvent, redactionConfig);
            aiCallsMade++;
            estimatedCost += provider.estimateCost(500);

            if (unit.outcome === 'failure' || unit.outcome === 'partial') {
              const rootCause = await provider.generateRootCause(combinedEvent, redactionConfig);
              if (rootCause) unit.rootCause = rootCause;
              aiCallsMade++;
              estimatedCost += provider.estimateCost(300);
            }
          })
        );

        for (const result of results) {
          if (result.status === 'rejected' && process.env.LOG_STORY_DEBUG) {
            console.error(`[log-story] AI narrative failed:`, result.reason?.message ?? result.reason);
          }
        }
      }
    } catch (outerErr: any) {
      if (process.env.LOG_STORY_DEBUG) {
        console.error(`[log-story] AI provider init failed:`, outerErr?.message ?? outerErr);
      }
    }

    return { aiCallsMade, estimatedCost };
  }

  /**
   * Build the final AnalysisResult from pipeline outputs.
   */
  private buildResult(
    entries: LogEntry[],
    groups: Map<string, LogEntry[]>,
    events: LogEvent[],
    storyUnits: StoryUnit[],
    aiCallsMade: number,
    estimatedCost: number,
    startTime: number,
    unparsedLines: number = 0,
  ): AnalysisResult {
    const insights = generateInsights(storyUnits);
    const systemSummary = generateSystemSummary(storyUnits, insights);

    return {
      storyUnits,
      insights,
      systemSummary,
      events,
      stats: {
        totalEntries: entries.length,
        groupsFound: groups.size,
        eventsExtracted: events.length,
        storiesGenerated: storyUnits.length,
        errorsDetected: entries.filter((e) => e.level === 'error' || e.level === 'fatal').length,
        aiCallsMade,
        estimatedCost,
        processingTimeMs: Date.now() - startTime,
        unparsedLines,
      },
    };
  }

  async analyze(input: string): Promise<AnalysisResult> {
    this.validateInputSize(input);
    const startTime = Date.now();

    // Format confidence gate: sample 20 lines, reject if <70% match a supported format
    const lines = input.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length >= 5) {
      const { confidence, matchedFormat, unmatchedSample } = checkFormatConfidence(lines);
      if (confidence < 0.7) {
        const error = new Error(
          `This log doesn't appear to be from a Node.js application.\n` +
          `  log-story supports: pino, winston, bunyan, morgan\n` +
          `  Confidence: ${Math.round(confidence * 100)}% of sampled lines matched a supported format.\n` +
          `  Run with --debug-parse to inspect unmatched lines.`
        );
        (error as any).code = 'UNRECOGNISED_FORMAT';
        (error as any).confidence = confidence;
        (error as any).unmatchedSample = unmatchedSample;
        throw error;
      }
    }

    const parseResult = parse(input);
    const { entries: rawEntries, unparsedLines, parseErrors } = parseResult;

    // Guard: if the vast majority of lines are unparsed, refuse to generate phantom stories
    const totalLines = rawEntries.length + parseErrors;
    if (totalLines >= 10 && unparsedLines / totalLines >= 0.9) {
      const error = new Error(
        `Log format not recognised: ${unparsedLines} of ${totalLines} lines could not be parsed.\n` +
        `  log-story supports: pino, winston, bunyan, morgan\n` +
        `  Run with --debug-parse to see which lines failed and why.`
      );
      (error as any).code = 'UNRECOGNISED_FORMAT';
      (error as any).unparsedLines = unparsedLines;
      (error as any).totalLines = totalLines;
      throw error;
    }

    const filtered = applyFilter(rawEntries, this.config.filter);
    const entries = this.applyRedaction(filtered);
    const { groups } = groupEntries(entries, this.config.grouping);
    const events = extractEvents(groups);
    const storyUnits = buildStoryUnits(events);
    const { aiCallsMade, estimatedCost } = await this.enhanceWithAI(storyUnits);

    return this.buildResult(entries, groups, events, storyUnits, aiCallsMade, estimatedCost, startTime, unparsedLines);
  }

  async analyzeJSON(logs: Record<string, unknown>[]): Promise<AnalysisResult> {
    const startTime = Date.now();

    const { entries: rawEntries } = parseJSON(logs);
    const filtered = applyFilter(rawEntries, this.config.filter);
    const entries = this.applyRedaction(filtered);
    const { groups } = groupEntries(entries, this.config.grouping);
    const events = extractEvents(groups);
    const storyUnits = buildStoryUnits(events);
    const { aiCallsMade, estimatedCost } = await this.enhanceWithAI(storyUnits);

    return this.buildResult(entries, groups, events, storyUnits, aiCallsMade, estimatedCost, startTime);
  }

  async query(question: string, context: AnalysisResult): Promise<string> {
    const { getProvider } = await import('./ai/index.js');

    const providerName = this.config.ai?.apiKey
      ? (this.config.ai.provider ?? 'openai')
      : 'local';

    const provider = await getProvider(
      providerName,
      this.config.ai?.apiKey ?? '',
      this.config.ai?.model
    );

    return provider.answerQuery(question, context.storyUnits);
  }

  format(result: AnalysisResult): string {
    return format(result, this.config.output?.format);
  }

  createStream(): LogStoryStream {
    return createAnalysisStream(this.config);
  }
}

export async function analyze(
  input: string,
  config?: LogStoryConfig
): Promise<AnalysisResult> {
  const instance = new LogStory(config);
  return instance.analyze(input);
}

export type {
  LogStoryConfig,
  AnalysisResult,
  AnalysisStats,
  LogEntry,
  LogEvent,
  StoryUnit,
  Insight,
  Action,
  AIProvider,
  OutputFormat,
  StreamConfig,
  LogStoryStreamEvent,
  RedactionConfig,
  FilterConfig,
} from './types/index.js';

export { createAnalysisStream } from './streaming/index.js';
export type { LogStoryStream } from './streaming/index.js';
export { clearCache } from './ai/cache.js';
export { redactPII, containsPII } from './parser/redaction.js';
