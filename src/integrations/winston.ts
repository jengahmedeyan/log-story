import { Writable } from 'node:stream';
import type { LogStoryConfig, StoryUnit, Insight, AnalysisStats } from '../types/index.js';
import { LogStory } from '../index.js';

export interface LogStoryTransportOptions {
  /** Number of log entries to buffer before analysis (default: 100) */
  bufferSize?: number;
  /** Max time in ms to buffer before flushing (default: 30000) */
  bufferTime?: number;
  /** Called when a story is generated */
  onStory?: (story: StoryUnit) => void;
  /** Called when an insight is detected */
  onInsight?: (insight: Insight) => void;
  /** Called with stats after each analysis batch */
  onBatch?: (stats: AnalysisStats) => void;
  /** LogStory configuration (AI, grouping, output) */
  config?: LogStoryConfig;
}

/**
 * A Winston-compatible transport that buffers log entries and periodically
 * analyzes them with log-story, emitting stories and insights.
 *
 * Usage:
 * ```typescript
 * import winston from 'winston';
 * import { LogStoryTransport } from 'log-story/integrations/winston';
 *
 * const logger = winston.createLogger({
 *   transports: [
 *     new winston.transports.Console(),
 *     new LogStoryTransport({
 *       bufferSize: 100,
 *       onStory: (story) => console.log(story.narrative),
 *     }),
 *   ],
 * });
 * ```
 */
export class LogStoryTransport extends Writable {
  private buffer: string[] = [];
  private bufferSize: number;
  private bufferTime: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private logStory: LogStory;
  private onStory?: (story: StoryUnit) => void;
  private onInsight?: (insight: Insight) => void;
  private onBatch?: (stats: AnalysisStats) => void;

  constructor(options: LogStoryTransportOptions = {}) {
    super({ objectMode: true });
    this.bufferSize = options.bufferSize ?? 100;
    this.bufferTime = options.bufferTime ?? 30000;
    this.onStory = options.onStory;
    this.onInsight = options.onInsight;
    this.onBatch = options.onBatch;
    this.logStory = new LogStory(options.config);
    this.resetTimer();
  }

  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    const line = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
    this.buffer.push(line);

    if (this.buffer.length >= this.bufferSize) {
      this.flush();
    }

    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      this.flush();
    }
    callback();
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.buffer.length > 0) {
        this.flush();
      }
      this.resetTimer();
    }, this.bufferTime);
  }

  private flush(): void {
    const logs = this.buffer.splice(0);
    if (logs.length === 0) return;

    this.resetTimer();

    const input = logs.join('\n');
    this.logStory.analyze(input).then((result) => {
      for (const story of result.storyUnits) {
        this.onStory?.(story);
      }
      for (const insight of result.insights) {
        this.onInsight?.(insight);
      }
      this.onBatch?.(result.stats);
    }).catch(() => {
      // Silently ignore analysis errors to not disrupt logging
    });
  }
}
