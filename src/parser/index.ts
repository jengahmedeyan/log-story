import type { LogEntry, LogFormat, ParseResult } from '../types/index.js';
import { detectFormat, detectLineFormat, checkFormatConfidence, parseWinstonJSON, parsePinoJSON, parseBunyanJSON, parseMorgan, parsePlainText } from './formats.js';
import { normalizeEntry, normalizeLevel, normalizeTimestamp } from './normalizer.js';

export { checkFormatConfidence } from './formats.js';

export type ParserFn = (line: string) => LogEntry | null;

const PARSERS: Record<LogFormat, ParserFn> = {
  'pino-json': parsePinoJSON,
  'winston-json': parseWinstonJSON,
  'bunyan-json': parseBunyanJSON,
  'morgan': parseMorgan,
  'plain': parsePlainText,
  'unknown': parsePlainText,
};

/**
 * Try to parse a line with the appropriate format parser, falling back to plain text.
 * Returns { entry, unparsed } where unparsed is true if only the unstructured fallback matched.
 */
function parseLine(line: string): { entry: LogEntry | null; unparsed: boolean } {
  const fmt = detectLineFormat(line);
  const parser = PARSERS[fmt];
  const entry = parser(line);
  if (entry) {
    // If the entry has an inferred timestamp, it hit the plain-text fallback
    const unparsed = entry.timestampInferred === true && fmt === 'plain';
    return { entry, unparsed };
  }
  // If the detected format's parser failed, try plain text as fallback
  if (fmt !== 'plain' && fmt !== 'unknown') {
    const fallback = parsePlainText(line);
    if (fallback) {
      const unparsed = fallback.timestampInferred === true;
      return { entry: fallback, unparsed };
    }
  }
  return { entry: null, unparsed: true };
}

/**
 * Parse raw log text into structured LogEntry array.
 */
export function parse(input: string, format?: LogFormat): ParseResult {
  const trimmed = input.trim();

  // Handle JSON array input (e.g., [{ ... }, { ... }])
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object') {
        return parseJSON(arr);
      }
    } catch {
      // Not valid JSON array, fall through to line-by-line parsing
    }
  }

  const lines = input.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { entries: [], detectedFormat: 'unknown', parseErrors: 0, inferredTimestamps: 0, unparsedLines: 0 };
  }

  const detectedFormat = format ?? detectFormat(lines);

  const entries: LogEntry[] = [];
  let parseErrors = 0;
  let unparsedLines = 0;
  const unparsedRaw: string[] = [];

  if (format) {
    // Explicit format: use single parser for all lines
    const parser = PARSERS[format];
    for (const line of lines) {
      const entry = parser(line);
      if (entry) {
        entries.push(entry);
        if (entry.timestampInferred) unparsedLines++;
      } else {
        parseErrors++;
        unparsedLines++;
        unparsedRaw.push(line);
      }
    }
  } else {
    // Per-line format detection for mixed-format files
    for (const line of lines) {
      const { entry, unparsed } = parseLine(line);
      if (entry) {
        entries.push(entry);
        if (unparsed) {
          unparsedLines++;
          unparsedRaw.push(line);
        }
      } else {
        parseErrors++;
        unparsedLines++;
        unparsedRaw.push(line);
      }
    }
  }

  // Write unparsed lines to stderr when debug mode is on
  if (unparsedRaw.length > 0 && process.env.LOG_STORY_DEBUG_PARSE) {
    for (const raw of unparsedRaw) {
      process.stderr.write(`[unparsed] No format matched: ${raw}\n`);
    }
  }

  const inferredTimestamps = entries.filter(e => e.timestampInferred).length;
  return { entries, detectedFormat, parseErrors, inferredTimestamps, unparsedLines };
}

/**
 * Parse an array of JSON log objects directly.
 */
export function parseJSON(logs: Record<string, unknown>[]): ParseResult {
  const entries: LogEntry[] = [];
  let parseErrors = 0;
  let detectedFormat: LogFormat = 'unknown';

  for (const log of logs) {
    const entry = parseObjectDirect(log);
    if (entry) {
      if (detectedFormat === 'unknown') {
        detectedFormat = ('msg' in log && ('time' in log || 'timestamp' in log)) ? 'pino-json' : 'winston-json';
      }
      entries.push(entry);
    } else {
      parseErrors++;
    }
  }

  const inferredTimestamps = entries.filter(e => e.timestampInferred).length;
  return { entries, detectedFormat, parseErrors, inferredTimestamps, unparsedLines: 0 };
}

/**
 * Parse a JSON object directly without re-serializing.
 */
function parseObjectDirect(obj: Record<string, unknown>): LogEntry | null {
  try {
    const { level, message, msg, timestamp, time, ...rest } = obj as any;
    const resolvedMessage = message ?? msg ?? '';
    const resolvedTimestamp = timestamp ?? time;
    const raw = JSON.stringify(obj);

    const ts = normalizeTimestamp(resolvedTimestamp);
    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: normalizeLevel(level),
      message: resolvedMessage,
      metadata: rest,
      requestId: rest.requestId ?? rest.request_id ?? rest.reqId ?? rest.req?.id ?? rest.req_id ?? rest.correlation_id ?? rest['x-request-id'],
      userId: rest.userId ?? rest.user_id ?? rest.uid ?? rest.user ?? rest.actor ?? rest.sub ?? rest.account_id
        ?? (rest.user as any)?.id ?? (rest.user as any)?.userId,
      sessionId: rest.sessionId ?? rest.session_id ?? rest.sessId,
      traceId: rest.traceId ?? rest.trace_id ?? rest.spanId,
      jobId: rest.jobId ?? rest.job_id ?? rest.job ?? rest.jid ?? rest.task_id,
      raw,
    });
  } catch {
    return null;
  }
}

export { detectFormat, detectLineFormat } from './formats.js';
export { redactPII, containsPII, type RedactionOptions } from './redaction.js';
