import type {
  LogStoryConfig,
  AnalysisResult,
  AIProvider,
  LogEvent,
  LogEntry,
  StoryUnit,
} from './types/index.js';
import { parse, parseJSON } from './parser/index.js';
import { groupEntries } from './grouping/index.js';
import { extractEvents } from './extraction/index.js';
import { buildStoryUnits } from './causality/index.js';
import { generateInsights, generateSystemSummary } from './insights/index.js';
import { format } from './output/index.js';
import { createAnalysisStream, type LogStoryStream } from './streaming/index.js';

export class LogStory {
  private config: LogStoryConfig;

  constructor(config: LogStoryConfig = {}) {
    this.config = config;
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

      for (const unit of storyUnits) {
        const primaryEvent = unit.events[0];
        if (!primaryEvent) continue;

        const combinedEvent: LogEvent = {
          ...primaryEvent,
          entries: unit.events.flatMap((e) => e.entries),
          actions: unit.events.flatMap((e) => e.actions),
          startTime: unit.startTime,
          endTime: unit.endTime,
          duration: unit.duration,
          outcome: unit.outcome,
        };

        try {
          unit.narrative = await provider.generateNarrative(combinedEvent, redactionConfig);
          aiCallsMade++;
          estimatedCost += provider.estimateCost(500);

          if (unit.outcome === 'failure' || unit.outcome === 'partial') {
            const rootCause = await provider.generateRootCause(combinedEvent, redactionConfig);
            if (rootCause) unit.rootCause = rootCause;
            aiCallsMade++;
            estimatedCost += provider.estimateCost(300);
          }
        } catch (innerErr: any) {
          if (process.env.LOG_STORY_DEBUG) {
            console.error(`[log-story] AI narrative failed for "${unit.title}":`, innerErr?.message ?? innerErr);
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
      },
    };
  }

  async analyze(input: string): Promise<AnalysisResult> {
    const startTime = Date.now();

    const { entries } = parse(input);
    const { groups } = groupEntries(entries, this.config.grouping);
    const events = extractEvents(groups);
    const storyUnits = buildStoryUnits(events);
    const { aiCallsMade, estimatedCost } = await this.enhanceWithAI(storyUnits);

    return this.buildResult(entries, groups, events, storyUnits, aiCallsMade, estimatedCost, startTime);
  }

  async analyzeJSON(logs: Record<string, unknown>[]): Promise<AnalysisResult> {
    const startTime = Date.now();

    const { entries } = parseJSON(logs);
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
} from './types/index.js';

export { createAnalysisStream } from './streaming/index.js';
export type { LogStoryStream } from './streaming/index.js';
export { clearCache } from './ai/cache.js';
export { redactPII, containsPII } from './parser/redaction.js';
