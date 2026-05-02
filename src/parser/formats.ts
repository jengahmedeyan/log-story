import type { LogEntry, LogFormat, LogLevel } from '../types/index.js';
import { normalizeLevel, normalizeTimestamp, normalizeEntry } from './normalizer.js';

const MORGAN_REGEX = /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[\w.-]+)\s+-\s+(?:\S+|-)\s+\[([^\]]+)\]\s+"(\w+)\s+([^\s"]+)\s+HTTP\/[\d.]+"\s+(\d{3})\s+(\d+|-)/;

/**
 * Pino/Bunyan numeric level → string mapping.
 */
const PINO_LEVELS: Record<number, LogLevel> = {
  10: 'debug',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * Detect log format from a sample of lines (file-level hint).
 */
export function detectFormat(lines: string[]): LogFormat {
  const sample = lines.slice(0, 20);

  for (const line of sample) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try JSON formats first
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        // Bunyan: has `v` field (version), `name`, and numeric `level`
        if ('v' in obj && 'name' in obj && typeof obj.level === 'number' && 'msg' in obj) {
          return 'bunyan-json';
        }
        // Pino: numeric level + msg + (time or timestamp)
        if (typeof obj.level === 'number' && 'msg' in obj && ('time' in obj || 'timestamp' in obj)) {
          return 'pino-json';
        }
        // Winston: string level + message
        if (typeof obj.level === 'string' && 'message' in obj) {
          return 'winston-json';
        }
        return 'unknown';
      } catch {
        // Not valid JSON
      }
    }

    // Morgan/Express access log format
    if (MORGAN_REGEX.test(trimmed)) {
      return 'morgan';
    }
  }

  // Check for plain text patterns that Node.js loggers produce
  for (const line of sample) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // [timestamp] LEVEL: message (Winston simple/console)
    if (/^\[([^\]]+)\]\s*(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)[:\s]/i.test(trimmed)) {
      return 'plain';
    }
    // timestamp LEVEL message (PM2, console.log with prefix)
    if (/^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s+(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\s/i.test(trimmed)) {
      return 'plain';
    }
    // timestamp [LEVEL] message
    if (/^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s+\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]/i.test(trimmed)) {
      return 'plain';
    }
  }

  return 'unknown';
}

/**
 * Detect format for a single line (per-line dispatching).
 */
export function detectLineFormat(line: string): LogFormat {
  const trimmed = line.trim();
  if (!trimmed) return 'unknown';

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if ('v' in obj && 'name' in obj && typeof obj.level === 'number' && 'msg' in obj) {
        return 'bunyan-json';
      }
      if (typeof obj.level === 'number' && 'msg' in obj && ('time' in obj || 'timestamp' in obj)) {
        return 'pino-json';
      }
      if (typeof obj.level === 'string' && 'message' in obj) {
        return 'winston-json';
      }
      return 'unknown';
    } catch {
      // Not JSON
    }
  }

  if (MORGAN_REGEX.test(trimmed)) {
    return 'morgan';
  }

  // Plain text patterns from Node.js loggers
  if (/^\[([^\]]+)\]\s*(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)[:\s]/i.test(trimmed)) {
    return 'plain';
  }
  if (/^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s+(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\s/i.test(trimmed)) {
    return 'plain';
  }
  if (/^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s+\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]/i.test(trimmed)) {
    return 'plain';
  }

  return 'unknown';
}

/**
 * Check if a sample of lines matches a supported Node.js log format.
 * Returns the confidence ratio (0-1) of lines that match a known format.
 */
export function checkFormatConfidence(lines: string[]): { confidence: number; matchedFormat: LogFormat; unmatchedSample: string[] } {
  const sample = lines.slice(0, 20);
  let matched = 0;
  const unmatched: string[] = [];

  for (const line of sample) {
    const trimmed = line.trim();
    if (!trimmed) {
      matched++; // empty lines don't count against
      continue;
    }
    const fmt = detectLineFormat(trimmed);
    if (fmt !== 'unknown') {
      matched++;
    } else {
      unmatched.push(trimmed);
    }
  }

  const confidence = sample.length > 0 ? matched / sample.length : 0;
  const matchedFormat = detectFormat(lines);

  return { confidence, matchedFormat, unmatchedSample: unmatched.slice(0, 5) };
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
      requestId: rest.requestId ?? rest.request_id ?? rest.reqId ?? rest.req_id ?? rest.correlation_id ?? rest['x-request-id'],
      userId: rest.userId ?? rest.user_id ?? rest.uid ?? rest.user ?? rest.actor ?? rest.sub ?? rest.account_id
        ?? (rest.user as any)?.id ?? (rest.user as any)?.userId,
      sessionId: rest.sessionId ?? rest.session_id ?? rest.sessId,
      traceId: rest.traceId ?? rest.trace_id ?? rest.spanId,
      jobId: rest.jobId ?? rest.job_id ?? rest.job ?? rest.jid ?? rest.task_id,
      format: 'winston-json',
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
      level: typeof level === 'number' ? (PINO_LEVELS[level] ?? normalizeLevel(String(level))) : normalizeLevel(level),
      message: msg ?? '',
      metadata: rest,
      requestId: rest.requestId ?? rest.reqId ?? rest.req?.id ?? rest.req_id ?? rest.request_id ?? rest.correlation_id ?? rest['x-request-id'],
      userId: rest.userId ?? rest.uid ?? rest.user ?? rest.actor ?? rest.sub ?? rest.account_id
        ?? (rest.user as any)?.id ?? (rest.user as any)?.userId,
      sessionId: rest.sessionId ?? rest.session_id ?? rest.sessId,
      traceId: rest.traceId ?? rest.trace_id,
      jobId: rest.jobId ?? rest.job_id ?? rest.job ?? rest.jid ?? rest.task_id,
      format: 'pino-json',
      raw: line,
    });
  } catch {
    return null;
  }
}

/**
 * Parse a Bunyan JSON log line.
 * Bunyan format: {"v":0,"level":30,"name":"myapp","hostname":"...","pid":1234,"time":"...","msg":"..."}
 */
export function parseBunyanJSON(line: string): LogEntry | null {
  try {
    const obj = JSON.parse(line);
    const { v, level, name, hostname, pid, time, msg, ...rest } = obj;
    const ts = normalizeTimestamp(time);

    const metadata: Record<string, unknown> = { ...rest };
    if (name) metadata.service = name;
    if (hostname) metadata.hostname = hostname;
    if (pid) metadata.pid = pid;

    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: typeof level === 'number' ? (PINO_LEVELS[level] ?? normalizeLevel(String(level))) : normalizeLevel(level),
      message: msg ?? '',
      metadata,
      source: name,
      requestId: rest.requestId ?? rest.reqId ?? rest.req_id ?? rest.request_id ?? rest.correlation_id ?? rest['x-request-id'],
      userId: rest.userId ?? rest.uid ?? rest.user ?? rest.actor ?? rest.sub ?? rest.account_id,
      sessionId: rest.sessionId ?? rest.session_id ?? rest.sessId,
      traceId: rest.traceId ?? rest.trace_id,
      jobId: rest.jobId ?? rest.job_id ?? rest.job ?? rest.jid ?? rest.task_id,
      format: 'bunyan-json',
      raw: line,
    });
  } catch {
    return null;
  }
}

/**
 * Parse a Morgan/Express access log line.
 * Format: ::ffff:127.0.0.1 - - [01/Jan/2024:10:30:00 +0000] "GET /api/users HTTP/1.1" 200 1234
 */
export function parseMorgan(line: string): LogEntry | null {
  const match = line.match(MORGAN_REGEX);
  if (!match) return null;

  const [, remoteAddr, timestampStr, method, path, statusStr, bytesStr] = match;
  const status = parseInt(statusStr, 10);
  const bytes = bytesStr === '-' ? 0 : parseInt(bytesStr, 10);

  // Parse CLF timestamp: 01/Jan/2024:10:30:00 +0000
  const ts = parseCLFTimestamp(timestampStr);

  // Infer level from HTTP status
  let level: LogLevel = 'info';
  if (status >= 500) level = 'error';
  else if (status >= 400) level = 'warn';

  const message = `${method} ${path} ${status}`;

  return normalizeEntry({
    timestamp: ts,
    timestampInferred: false,
    level,
    message,
    metadata: {
      method,
      path,
      status,
      bytes,
      remoteAddr,
    },
    format: 'morgan',
    raw: line,
  });
}

function parseCLFTimestamp(str: string): Date {
  // Format: 01/Jan/2024:10:30:00 +0000
  const match = str.match(/(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/);
  if (!match) return new Date();

  const [, day, monthStr, year, hour, min, sec, tz] = match;
  const monthMap: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const month = monthMap[monthStr] ?? '01';
  const isoStr = `${year}-${month}-${day}T${hour}:${min}:${sec}${tz ? tz.slice(0, 3) + ':' + tz.slice(3) : 'Z'}`;
  const date = new Date(isoStr);
  return isNaN(date.getTime()) ? new Date() : date;
}

/**
 * Parse a plain text log line (Winston simple, PM2, console.log with timestamps).
 * Supports:
 *   [2024-01-15T10:30:00Z] ERROR: something happened
 *   2024-01-15 10:30:00 INFO something happened
 *   2024-01-15 10:30:00 [INFO] [component] something happened
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
      format: 'plain',
      raw: line,
    });
  }

  // Pattern: timestamp [LEVEL] [component] message
  const bracketLevelMatch = line.match(
    /^(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s+\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]\s+(?:\[([^\]]+)\]\s*)?(.+)/i
  );
  if (bracketLevelMatch) {
    const rawMessage = bracketLevelMatch[4].trim();
    const component = bracketLevelMatch[3] ?? undefined;
    const metadata: Record<string, unknown> = extractKeyValuePairs(rawMessage);
    if (component) metadata.component = component;

    const requestId = metadata['id'] ?? metadata['request_id'] ?? metadata['requestId'] ?? metadata['reqId']
      ?? metadata['correlation_id'] ?? metadata['x-request-id'];
    const userId = metadata['user'] ?? metadata['userId'] ?? metadata['user_id'] ?? metadata['uid']
      ?? metadata['actor'] ?? metadata['sub'] ?? metadata['account_id'];
    const jobId = metadata['job_id'] ?? metadata['job'] ?? metadata['jid'] ?? metadata['task_id'] ?? metadata['jobId'];

    const ts = normalizeTimestamp(bracketLevelMatch[1]);
    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: normalizeLevel(bracketLevelMatch[2]),
      message: rawMessage,
      metadata,
      requestId: requestId as string | undefined,
      userId: userId as string | undefined,
      jobId: jobId as string | undefined,
      source: component,
      format: 'plain',
      raw: line,
    });
  }

  // Pattern: timestamp [component] key=value pairs
  const componentKVMatch = line.match(
    /^(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s+\[([^\]]+)\]\s+(.+)/i
  );
  if (componentKVMatch) {
    const rawMessage = componentKVMatch[3].trim();
    const component = componentKVMatch[2];
    const metadata: Record<string, unknown> = extractKeyValuePairs(rawMessage);
    if (component) metadata.component = component;

    let level: LogLevel = 'info';
    const statusVal = typeof metadata['status'] === 'string' ? metadata['status'].toLowerCase() : '';
    if (statusVal === 'warn' || statusVal === 'warning') {
      level = 'warn';
    } else if (statusVal === 'error' || statusVal === 'fail' || statusVal === 'failed') {
      level = 'error';
    } else {
      level = inferLevelFromMessage(rawMessage);
    }

    const requestId = metadata['request_id'] ?? metadata['requestId'] ?? metadata['reqId']
      ?? metadata['correlation_id'] ?? metadata['x-request-id'] ?? metadata['id'];
    const userId = metadata['user'] ?? metadata['userId'] ?? metadata['user_id'] ?? metadata['uid']
      ?? metadata['actor'] ?? metadata['sub'] ?? metadata['account_id'];
    const jobId = metadata['job_id'] ?? metadata['job'] ?? metadata['jid'] ?? metadata['task_id'] ?? metadata['jobId'];

    const ts = normalizeTimestamp(componentKVMatch[1]);
    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level,
      message: rawMessage,
      metadata,
      requestId: requestId as string | undefined,
      userId: userId as string | undefined,
      jobId: jobId as string | undefined,
      source: component,
      format: 'plain',
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
    const requestId = metadata['id'] ?? metadata['request_id'] ?? metadata['requestId'] ?? metadata['reqId']
      ?? metadata['correlation_id'] ?? metadata['x-request-id'];
    const userId = metadata['user'] ?? metadata['userId'] ?? metadata['user_id'] ?? metadata['uid']
      ?? metadata['actor'] ?? metadata['sub'] ?? metadata['account_id'];
    const jobId = metadata['job_id'] ?? metadata['job'] ?? metadata['jid'] ?? metadata['task_id'] ?? metadata['jobId'];

    const ts = normalizeTimestamp(spaceMatch[1]);
    return normalizeEntry({
      timestamp: ts.date,
      timestampInferred: ts.inferred,
      level: normalizeLevel(spaceMatch[2]),
      message,
      metadata,
      requestId: requestId as string | undefined,
      userId: userId as string | undefined,
      jobId: jobId as string | undefined,
      format: 'plain',
      raw: line,
    });
  }

  // No match — return null (unrecognised line)
  return null;
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
  const regex = /(\w+)=([^\s,;)}\]]+)/g;
  let match;
  while ((match = regex.exec(message)) !== null) {
    pairs[match[1]] = match[2];
  }
  return pairs;
}
