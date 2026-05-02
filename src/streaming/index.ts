import { Transform, type TransformCallback } from 'node:stream';
import { createHash } from 'node:crypto';
import type {
  LogEntry,
  LogStoryConfig,
  StreamConfig,
  StoryUnit,
  Insight,
  AnalysisStats,
  LogStoryStreamEvent,
} from '../types/index.js';
import { parse } from '../parser/index.js';
import { groupEntries } from '../grouping/index.js';
import { extractEvents } from '../extraction/index.js';
import { buildStoryUnits } from '../causality/index.js';
import { generateInsights } from '../insights/index.js';

/**
 * Generate a signature for a story to detect duplicates from overlap processing.
 */
function storySignature(story: StoryUnit): string {
  const entryKeys = story.events
    .flatMap((e) => e.entries)
    .map((e) => `${e.timestamp.getTime()}:${e.message.slice(0, 40)}`)
    .sort()
    .join('|');
  return createHash('sha256').update(entryKeys).digest('hex').substring(0, 16);
}

/**
 * A Transform stream that processes log text and emits LogStoryStreamEvent objects.
 * Also emits custom events: 'story', 'insight', 'done'.
 */
export type LogStoryStream = Transform;

/**
 * Creates a Transform stream that processes log input in chunks,
 * emitting stories and insights incrementally.
 *
 * Usage:
 *   const stream = createAnalysisStream(config);
 *   readableStream.pipe(stream);
 *   stream.on('story', (story) => { ... });
 *   stream.on('insight', (insight) => { ... });
 *   stream.on('done', (stats) => { ... });
 */
export function createAnalysisStream(config: LogStoryConfig = {}): LogStoryStream {
  const streamConfig: Required<StreamConfig> = {
    chunkSize: config.streaming?.chunkSize ?? 500,
    flushInterval: config.streaming?.flushInterval ?? 5000,
    overlapSize: config.streaming?.overlapSize ?? 50,
  };

  let buffer = '';
  let entryBuffer: LogEntry[] = [];
  let overlapEntries: LogEntry[] = [];
  let totalEntriesProcessed = 0;
  let chunksProcessed = 0;
  let totalStoriesGenerated = 0;
  let totalErrorsDetected = 0;
  let allStories: StoryUnit[] = [];
  const emittedStorySignatures = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const startTime = Date.now();

  const stream = new Transform({
    objectMode: true,
    transform(chunk: Buffer | string, _encoding: string, callback: TransformCallback) {
      buffer += chunk.toString();

      // Parse complete lines
      const lines = buffer.split('\n');
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? '';

      const raw = lines.filter((l) => l.trim().length > 0).join('\n');
      if (raw.length === 0) {
        callback();
        return;
      }

      const { entries } = parse(raw);
      entryBuffer.push(...entries);

      // Process when chunk size threshold is reached
      if (entryBuffer.length >= streamConfig.chunkSize) {
        processChunk(stream);
      } else {
        resetFlushTimer(stream);
      }

      callback();
    },
    flush(callback: TransformCallback) {
      // Process any remaining entries
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      if (entryBuffer.length > 0) {
        processChunk(stream, true);
      }

      // Generate final insights from all accumulated stories
      const insights = generateInsights(allStories);
      for (const insight of insights) {
        const event: LogStoryStreamEvent = { type: 'insight', insight };
        stream.push(event);
        stream.emit('insight', insight);
      }

      // Emit done event with final stats
      const stats: AnalysisStats = {
        totalEntries: totalEntriesProcessed,
        groupsFound: chunksProcessed,
        eventsExtracted: totalEntriesProcessed,
        storiesGenerated: totalStoriesGenerated,
        errorsDetected: totalErrorsDetected,
        aiCallsMade: 0,
        estimatedCost: 0,
        processingTimeMs: Date.now() - startTime,
        unparsedLines: 0,
      };

      const doneEvent: LogStoryStreamEvent = { type: 'done', stats };
      stream.push(doneEvent);
      stream.emit('done', stats);

      callback();
    },
  });

  function resetFlushTimer(s: Transform) {
    if (flushTimer) {
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => {
      if (entryBuffer.length > 0) {
        processChunk(s);
      }
    }, streamConfig.flushInterval);
  }

  function processChunk(s: Transform, isFinal = false) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    // Prepend overlap entries from previous chunk for grouping continuity
    const entriesToProcess = [...overlapEntries, ...entryBuffer];
    const newEntryCount = entryBuffer.length;

    // Save overlap for next chunk (not needed on final flush)
    if (!isFinal) {
      overlapEntries = entryBuffer.slice(-streamConfig.overlapSize);
    } else {
      overlapEntries = [];
    }
    entryBuffer = [];

    totalEntriesProcessed += newEntryCount;
    totalErrorsDetected += entriesToProcess.filter(
      (e) => e.level === 'error' || e.level === 'fatal'
    ).length;

    // Run the pipeline on this chunk
    const { groups } = groupEntries(entriesToProcess, config.grouping);
    const events = extractEvents(groups);
    const stories = buildStoryUnits(events);

    chunksProcessed++;

    // Deduplicate stories from overlap entries
    for (const story of stories) {
      const sig = storySignature(story);
      if (emittedStorySignatures.has(sig)) continue;
      emittedStorySignatures.add(sig);

      totalStoriesGenerated++;
      allStories.push(story);

      const event: LogStoryStreamEvent = { type: 'story', story };
      s.push(event);
      s.emit('story', story);
    }

    // Emit progress
    const progress: LogStoryStreamEvent = {
      type: 'progress',
      entriesProcessed: totalEntriesProcessed,
      chunksProcessed,
      storiesGenerated: totalStoriesGenerated,
    };
    s.push(progress);
  }

  return stream as LogStoryStream;
}
