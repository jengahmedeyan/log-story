import type { LogEntry, LogLevel } from '../types/index.js';

const LEVEL_MAP: Record<string, LogLevel> = {
  // Standard levels
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  fatal: 'fatal',
  critical: 'fatal',
  // Domain-specific levels (treat as info)
  request: 'info',
  payment: 'info',
  db: 'info',
  cache: 'info',
  // Numeric levels (Winston)
  '0': 'error',
  '1': 'warn',
  '2': 'info',
  '3': 'debug',
  // Pino numeric levels
  '10': 'debug',
  '20': 'debug',
  '30': 'info',
  '40': 'warn',
  '50': 'error',
  '60': 'fatal',
};

export function normalizeLevel(raw: string | number | undefined): LogLevel {
  if (raw === undefined || raw === null) return 'info';
  const key = String(raw).toLowerCase().trim();
  return LEVEL_MAP[key] ?? 'info';
}

export interface TimestampResult {
  date: Date;
  inferred: boolean;
}

export function normalizeTimestamp(raw: unknown): TimestampResult {
  if (raw instanceof Date) return { date: raw, inferred: false };
  if (typeof raw === 'number') return { date: new Date(raw), inferred: false };
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) return { date: parsed, inferred: false };
  }
  return { date: new Date(), inferred: true };
}

export function normalizeEntry(partial: Partial<LogEntry> & { raw: string }): LogEntry {
  return {
    timestamp: partial.timestamp ?? new Date(),
    level: partial.level ?? 'info',
    message: partial.message ?? partial.raw,
    metadata: partial.metadata ?? {},
    source: partial.source,
    requestId: partial.requestId,
    userId: partial.userId,
    sessionId: partial.sessionId,
    traceId: partial.traceId,
    timestampInferred: partial.timestampInferred,
    raw: partial.raw,
  };
}
