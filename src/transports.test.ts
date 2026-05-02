import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse, checkFormatConfidence } from './parser/index.js';
import type { LogFormat } from './types/index.js';

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, '__fixtures__', name), 'utf-8');
}

describe('Node.js Transport Fixtures', () => {
  describe('Pino JSON', () => {
    const input = loadFixture('pino-sample.log');

    it('detects format as pino-json', () => {
      const result = parse(input);
      expect(result.detectedFormat).toBe('pino-json');
    });

    it('parses all lines successfully', () => {
      const result = parse(input);
      expect(result.parseErrors).toBe(0);
      expect(result.unparsedLines).toBe(0);
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('extracts reqId as requestId', () => {
      const result = parse(input);
      const withReqId = result.entries.filter(e => e.requestId);
      expect(withReqId.length).toBeGreaterThan(0);
      expect(withReqId[0].requestId).toBe('req-abc-001');
    });

    it('extracts jobId from metadata', () => {
      const result = parse(input);
      const withJobId = result.entries.filter(e => e.jobId);
      expect(withJobId.length).toBeGreaterThan(0);
      expect(withJobId[0].jobId).toBe('job-email-77');
    });

    it('maps numeric levels correctly', () => {
      const result = parse(input);
      const levels = new Set(result.entries.map(e => e.level));
      expect(levels.has('info')).toBe(true);
      expect(levels.has('error')).toBe(true);
      expect(levels.has('warn')).toBe(true);
    });

    it('passes format confidence check', () => {
      const lines = input.split('\n').filter(l => l.trim());
      const { confidence } = checkFormatConfidence(lines);
      expect(confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Winston JSON', () => {
    const input = loadFixture('winston-sample.log');

    it('detects format as winston-json', () => {
      const result = parse(input);
      expect(result.detectedFormat).toBe('winston-json');
    });

    it('parses all lines successfully', () => {
      const result = parse(input);
      expect(result.parseErrors).toBe(0);
      expect(result.unparsedLines).toBe(0);
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('extracts requestId', () => {
      const result = parse(input);
      const withReqId = result.entries.filter(e => e.requestId);
      expect(withReqId.length).toBeGreaterThan(0);
      expect(withReqId[0].requestId).toBe('req-w-001');
    });

    it('extracts userId', () => {
      const result = parse(input);
      const withUserId = result.entries.filter(e => e.userId);
      expect(withUserId.length).toBeGreaterThan(0);
      expect(withUserId[0].userId).toBe('user-55');
    });

    it('extracts sessionId', () => {
      const result = parse(input);
      const withSessionId = result.entries.filter(e => e.sessionId);
      expect(withSessionId.length).toBeGreaterThan(0);
      expect(withSessionId[0].sessionId).toBe('sess-abc-123');
    });

    it('passes format confidence check', () => {
      const lines = input.split('\n').filter(l => l.trim());
      const { confidence } = checkFormatConfidence(lines);
      expect(confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Bunyan JSON', () => {
    const input = loadFixture('bunyan-sample.log');

    it('detects format as bunyan-json', () => {
      const result = parse(input);
      expect(result.detectedFormat).toBe('bunyan-json');
    });

    it('parses all lines successfully', () => {
      const result = parse(input);
      expect(result.parseErrors).toBe(0);
      expect(result.unparsedLines).toBe(0);
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('extracts service name as source', () => {
      const result = parse(input);
      const withSource = result.entries.filter(e => e.source);
      expect(withSource.length).toBeGreaterThan(0);
      expect(withSource[0].source).toBe('myapp');
    });

    it('extracts reqId as requestId', () => {
      const result = parse(input);
      const withReqId = result.entries.filter(e => e.requestId);
      expect(withReqId.length).toBeGreaterThan(0);
      expect(withReqId[0].requestId).toBe('bunyan-req-001');
    });

    it('maps numeric levels correctly', () => {
      const result = parse(input);
      const levels = new Set(result.entries.map(e => e.level));
      expect(levels.has('info')).toBe(true);
      expect(levels.has('error')).toBe(true);
      expect(levels.has('warn')).toBe(true);
    });

    it('passes format confidence check', () => {
      const lines = input.split('\n').filter(l => l.trim());
      const { confidence } = checkFormatConfidence(lines);
      expect(confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Morgan/Express Access Log', () => {
    const input = loadFixture('morgan-sample.log');

    it('detects format as morgan', () => {
      const result = parse(input);
      expect(result.detectedFormat).toBe('morgan');
    });

    it('parses all lines successfully', () => {
      const result = parse(input);
      expect(result.parseErrors).toBe(0);
      expect(result.unparsedLines).toBe(0);
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('extracts HTTP method, path, and status', () => {
      const result = parse(input);
      const first = result.entries[0];
      expect(first.message).toContain('GET');
      expect(first.message).toContain('/api/health');
      expect(first.message).toContain('200');
    });

    it('infers level from HTTP status codes', () => {
      const result = parse(input);
      const errorEntries = result.entries.filter(e => e.level === 'error');
      const warnEntries = result.entries.filter(e => e.level === 'warn');
      expect(errorEntries.length).toBeGreaterThan(0); // 500 status
      expect(warnEntries.length).toBeGreaterThan(0); // 401, 403, 404 statuses
    });

    it('passes format confidence check', () => {
      const lines = input.split('\n').filter(l => l.trim());
      const { confidence } = checkFormatConfidence(lines);
      expect(confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('Format Rejection', () => {
    it('rejects syslog format', () => {
      const syslog = `Jun 14 15:16:01 combo sshd[1234]: Failed password for root from 10.0.0.1
Jun 14 15:16:02 combo sshd[1234]: pam_unix(sshd:auth): authentication failure
Jun 14 15:16:03 combo sshd[1234]: Failed password for invalid user admin`;
      const lines = syslog.split('\n').filter(l => l.trim());
      const { confidence } = checkFormatConfidence(lines);
      expect(confidence).toBeLessThan(0.7);
    });

    it('rejects pipe-delimited format (HealthApp)', () => {
      const healthApp = `20110101-000000|Component1|PID1234|Address1|NONE|Type1|Content
20110101-000001|Component2|PID5678|Address2|NONE|Type2|Content
20110101-000002|Component3|PID9012|Address3|NONE|Type3|Content`;
      const lines = healthApp.split('\n').filter(l => l.trim());
      const { confidence } = checkFormatConfidence(lines);
      expect(confidence).toBeLessThan(0.7);
    });

    it('rejects Linux kernel log format', () => {
      const kernelLog = `Jun 14 15:16:01 combo kernel: Initializing CPU#0
Jun 14 15:16:01 combo kernel: Detected 2667.731 MHz processor
Jun 14 15:16:01 combo kernel: Memory: 255472k available`;
      const lines = kernelLog.split('\n').filter(l => l.trim());
      const { confidence } = checkFormatConfidence(lines);
      expect(confidence).toBeLessThan(0.7);
    });
  });
});
