import { Transform, type TransformCallback } from 'node:stream';
import type { LogStoryConfig, StoryUnit, Insight, AnalysisStats } from '../types/index.js';
import { createAnalysisStream } from '../streaming/index.js';

export interface PinoTransportOptions {
  /** Number of entries per analysis chunk (default: 50) */
  chunkSize?: number;
  /** Called when a story is generated */
  onStory?: (story: StoryUnit) => void;
  /** Called when an insight is detected */
  onInsight?: (insight: Insight) => void;
  /** Called with stats when analysis completes */
  onDone?: (stats: AnalysisStats) => void;
  /** LogStory configuration */
  config?: LogStoryConfig;
}

/**
 * Creates a Pino-compatible transport that analyzes logs with log-story.
 * This is a pass-through Transform stream: it forwards log lines to stdout
 * while also feeding them to log-story for analysis.
 *
 * Usage:
 * ```typescript
 * import pino from 'pino';
 * import { createPinoTransport } from 'log-story/integrations/pino';
 *
 * const transport = createPinoTransport({
 *   onStory: (story) => console.error(`[log-story] ${story.narrative}`),
 * });
 *
 * const logger = pino(transport);
 * ```
 */
export function createPinoTransport(options: PinoTransportOptions = {}): Transform {
  const chunkSize = options.chunkSize ?? 50;
  const config: LogStoryConfig = {
    ...options.config,
    streaming: { chunkSize, ...options.config?.streaming },
  };

  const analysisStream = createAnalysisStream(config);

  if (options.onStory) {
    analysisStream.on('story', options.onStory);
  }
  if (options.onInsight) {
    analysisStream.on('insight', options.onInsight);
  }
  if (options.onDone) {
    analysisStream.on('done', options.onDone);
  }

  const passthrough = new Transform({
    transform(chunk: Buffer | string, _encoding: string, callback: TransformCallback) {
      // Feed to analysis stream (non-blocking)
      analysisStream.write(chunk);
      // Pass through to output
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      analysisStream.end();
      callback();
    },
  });

  return passthrough;
}
