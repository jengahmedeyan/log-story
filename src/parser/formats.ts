import type { LogEntry, LogFormat, LogLevel } from '../types/index.js';
import { normalizeLevel, normalizeTimestamp, normalizeEntry } from './normalizer.js';

/**
 * Detect log format from a sample of lines.
 */
export function detectFormat(lines: string[]): LogFormat {
  const sample = lines.slice(0, 10);

  for (const line of sample) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try JSON formats
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if ('level' in obj && 'msg' in obj && ('time' in obj || 'timestamp' in obj)) {
          return 'pino-json';
        }
        if ('level' in obj && 'message' in obj) {
          return 'winston-json';
        }
        return 'unknown'; // Unrecognized JSON structure
      } catch {
        // Not JSON
      }
    }
  }

  return 'plain';
}

/**
 * Parse a Winston JSON log line.
 */
export function parseWinstonJSON(line: string): LogEntry | null {
  try {
    const obj = JSON.parse(line);
    const { level, message, timestamp, ...rest } = obj;
    const ts = normalizeTimestamp(timestamp);

    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: normalizeLevel(level),
      message: message ?? '',
      metadata: rest,
      requestId: rest.requestId ?? rest.request_id ?? rest.reqId,
      userId: rest.userId ?? rest.user_id ?? rest.uid
        ?? (rest.user as any)?.id ?? (rest.user as any)?.userId,
      sessionId: rest.sessionId ?? rest.session_id ?? rest.sessId,
      traceId: rest.traceId ?? rest.trace_id ?? rest.spanId,
      raw: line,
    });
  } catch {
    return null;
  }
}

/**
 * Parse a Pino JSON log line.
 */
export function parsePinoJSON(line: string): LogEntry | null {
  try {
    const obj = JSON.parse(line);
    const { level, msg, time, timestamp, ...rest } = obj;
    const ts = normalizeTimestamp(time ?? timestamp);

    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: normalizeLevel(level),
      message: msg ?? '',
      metadata: rest,
      requestId: rest.requestId ?? rest.reqId ?? rest.req?.id,
      userId: rest.userId ?? rest.uid
        ?? (rest.user as any)?.id ?? (rest.user as any)?.userId,
      sessionId: rest.sessionId ?? rest.session_id ?? rest.sessId,
      traceId: rest.traceId ?? rest.trace_id,
      raw: line,
    });
  } catch {
    return null;
  }
}

/**
 * Parse a plain text log line.
 * Supports common formats like:
 *   [2024-01-15T10:30:00Z] ERROR: something happened
 *   2024-01-15 10:30:00 INFO something happened
 */
export function parsePlainText(line: string): LogEntry | null {
  if (!line.trim()) return null;

  // Pattern: [timestamp] LEVEL: message
  const bracketMatch = line.match(
    /^\[([^\]]+)\]\s*(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)[:\s]+(.+)/i
  );
  if (bracketMatch) {
    const ts = normalizeTimestamp(bracketMatch[1]);
    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: normalizeLevel(bracketMatch[2]),
      message: bracketMatch[3].trim(),
      metadata: {},
      raw: line,
    });
  }

  // Pattern: timestamp LEVEL message (with optional key=value metadata)
  const spaceMatch = line.match(
    /^(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s+(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL|REQUEST|PAYMENT|CACHE|DB)\s+(.+)/i
  );
  if (spaceMatch) {
    const message = spaceMatch[3].trim();
    const metadata = extractKeyValuePairs(message);
    const requestId = metadata['id'] ?? metadata['request_id'] ?? metadata['requestId'] ?? metadata['reqId'];
    const userId = metadata['user'] ?? metadata['userId'] ?? metadata['user_id'] ?? metadata['uid'];

    const ts = normalizeTimestamp(spaceMatch[1]);
    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: normalizeLevel(spaceMatch[2]),
      message,
      metadata,
      requestId: requestId as string | undefined,
      userId: userId as string | undefined,
      raw: line,
    });
  }

  // Fallback: treat entire line as message
  return normalizeEntry({
    timestamp: new Date(),
    timestampInferred: true,
    level: inferLevelFromMessage(line),
    message: line.trim(),
    metadata: {},
    raw: line,
  });
}

function inferLevelFromMessage(message: string): LogLevel {
  const lower = message.toLowerCase();
  if (lower.includes('error') || lower.includes('fail') || lower.includes('exception') || lower.includes('timeout')) return 'error';
  if (lower.includes('warn')) return 'warn';
  if (lower.includes('debug') || lower.includes('trace')) return 'debug';
  return 'info';
}

/**
 * Extract key=value pairs from a log message.
 */
function extractKeyValuePairs(message: string): Record<string, unknown> {
  const pairs: Record<string, unknown> = {};
  const regex = /(\w+)=([^\s]+)/g;
  let match;
  while ((match = regex.exec(message)) !== null) {
    pairs[match[1]] = match[2];
  }
  return pairs;
}
