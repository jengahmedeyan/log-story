import type { LogEntry, LogFormat, ParseResult } from '../types/index.js';
import { detectFormat, parseWinstonJSON, parsePinoJSON, parsePlainText } from './formats.js';

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
    return { entries: [], detectedFormat: 'unknown', parseErrors: 0 };
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

  return { entries, detectedFormat, parseErrors };
}

/**
 * Parse an array of JSON log objects directly.
 */
export function parseJSON(logs: Record<string, unknown>[]): ParseResult {
  const entries: LogEntry[] = [];
  let parseErrors = 0;

  for (const log of logs) {
    const line = JSON.stringify(log);
    const entry = parseWinstonJSON(line) ?? parsePinoJSON(line);
    if (entry) {
      entries.push(entry);
    } else {
      parseErrors++;
    }
  }

  return { entries, detectedFormat: 'winston-json', parseErrors };
}

export { detectFormat } from './formats.js';
