import type { LogEntry, LogFormat, ParseResult } from '../types/index.js';
import { detectFormat, parseWinstonJSON, parsePinoJSON, parsePlainText } from './formats.js';
import { normalizeEntry, normalizeLevel, normalizeTimestamp } from './normalizer.js';

export type ParserFn = (line: string) => LogEntry | null;

const PARSERS: Record<LogFormat, ParserFn> = {
  'winston-json': parseWinstonJSON,
  'pino-json': parsePinoJSON,
  'plain': parsePlainText,
  'clf': parsePlainText, // TODO: dedicated CLF parser
  'unknown': parsePlainText,
};

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
    return { entries: [], detectedFormat: 'unknown', parseErrors: 0, inferredTimestamps: 0 };
  }

  const detectedFormat = format ?? detectFormat(lines);
  const parser = PARSERS[detectedFormat];

  const entries: LogEntry[] = [];
  let parseErrors = 0;

  for (const line of lines) {
    const entry = parser(line);
    if (entry) {
      entries.push(entry);
    } else {
      parseErrors++;
    }
  }

  const inferredTimestamps = entries.filter(e => e.timestampInferred).length;
  return { entries, detectedFormat, parseErrors, inferredTimestamps };
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
  return { entries, detectedFormat, parseErrors, inferredTimestamps };
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
      requestId: rest.requestId ?? rest.request_id ?? rest.reqId ?? rest.req?.id,
      userId: rest.userId ?? rest.user_id ?? rest.uid
        ?? (rest.user as any)?.id ?? (rest.user as any)?.userId,
      sessionId: rest.sessionId ?? rest.session_id ?? rest.sessId,
      traceId: rest.traceId ?? rest.trace_id ?? rest.spanId,
      raw,
    });
  } catch {
    return null;
  }
}

export { detectFormat } from './formats.js';
export { redactPII, containsPII, type RedactionOptions } from './redaction.js';
