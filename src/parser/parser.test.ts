import { describe, it, expect } from 'vitest';
import { parse } from '../parser/index.js';
import { detectFormat } from '../parser/formats.js';

describe('Parser', () => {
  describe('detectFormat', () => {
    it('detects Winston JSON format', () => {
      const lines = ['{"level":"info","message":"Server started","timestamp":"2024-01-15T10:00:00Z"}'];
      expect(detectFormat(lines)).toBe('winston-json');
    });

    it('detects Pino JSON format', () => {
      const lines = ['{"level":30,"msg":"Server started","time":1705312800000}'];
      expect(detectFormat(lines)).toBe('pino-json');
    });

    it('detects plain text format', () => {
      const lines = ['[2024-01-15T10:00:00Z] INFO: Server started'];
      expect(detectFormat(lines)).toBe('plain');
    });
  });

  describe('parse', () => {
    it('parses plain text logs', () => {
      const input = `[2024-01-15T10:00:00Z] INFO: Server started
[2024-01-15T10:00:01Z] ERROR: Connection failed`;

      const result = parse(input);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].level).toBe('info');
      expect(result.entries[0].message).toBe('Server started');
      expect(result.entries[1].level).toBe('error');
      expect(result.entries[1].message).toBe('Connection failed');
    });

    it('parses Winston JSON logs', () => {
      const input = `{"level":"info","message":"Request received","timestamp":"2024-01-15T10:00:00Z","requestId":"abc-123"}
{"level":"error","message":"Payment failed","timestamp":"2024-01-15T10:00:05Z","requestId":"abc-123"}`;

      const result = parse(input);
      expect(result.entries).toHaveLength(2);
      expect(result.detectedFormat).toBe('winston-json');
      expect(result.entries[0].requestId).toBe('abc-123');
      expect(result.entries[1].level).toBe('error');
    });

    it('parses Pino JSON logs', () => {
      const input = `{"level":30,"msg":"Request started","time":1705312800000,"reqId":"xyz-789"}
{"level":50,"msg":"Timeout occurred","time":1705312805000,"reqId":"xyz-789"}`;

      const result = parse(input);
      expect(result.entries).toHaveLength(2);
      expect(result.detectedFormat).toBe('pino-json');
      expect(result.entries[0].level).toBe('info');
      expect(result.entries[1].level).toBe('error');
    });

    it('handles empty input', () => {
      const result = parse('');
      expect(result.entries).toHaveLength(0);
      expect(result.detectedFormat).toBe('unknown');
    });

    it('rejects unstructured plain text without timestamps', () => {
      const input = `POST /checkout
calling payment API
retry payment API
timeout after 5000ms`;

      const result = parse(input);
      expect(result.entries).toHaveLength(0);
      expect(result.unparsedLines).toBe(4);
    });
  });
});
