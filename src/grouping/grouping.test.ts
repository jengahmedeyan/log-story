import { describe, it, expect } from 'vitest';
import { groupById } from '../grouping/id-grouper.js';
import { groupByTime } from '../grouping/time-grouper.js';
import { groupEntries } from '../grouping/index.js';
import type { LogEntry } from '../types/index.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date('2024-01-15T10:00:00Z'),
    level: 'info',
    message: 'test',
    metadata: {},
    raw: 'test',
    ...overrides,
  };
}

describe('Grouping', () => {
  describe('groupById', () => {
    it('groups entries by requestId', () => {
      const entries = [
        makeEntry({ requestId: 'req-1', message: 'start' }),
        makeEntry({ requestId: 'req-1', message: 'end' }),
        makeEntry({ requestId: 'req-2', message: 'other' }),
      ];

      const { groups, ungrouped } = groupById(entries);
      expect(groups.size).toBe(2);
      expect(groups.get('requestId:req-1')).toHaveLength(2);
      expect(groups.get('requestId:req-2')).toHaveLength(1);
      expect(ungrouped).toHaveLength(0);
    });

    it('leaves entries without IDs as ungrouped', () => {
      const entries = [
        makeEntry({ requestId: 'req-1' }),
        makeEntry({}), // No ID
      ];

      const { groups, ungrouped } = groupById(entries);
      expect(groups.size).toBe(1);
      expect(ungrouped).toHaveLength(1);
    });

    it('prioritizes traceId over requestId', () => {
      const entries = [
        makeEntry({ traceId: 'trace-1', requestId: 'req-1' }),
      ];

      const { groups } = groupById(entries);
      expect(groups.has('traceId:trace-1')).toBe(true);
      expect(groups.has('requestId:req-1')).toBe(false);
    });
  });

  describe('groupByTime', () => {
    it('groups entries within time window', () => {
      const entries = [
        makeEntry({ timestamp: new Date('2024-01-15T10:00:00Z') }),
        makeEntry({ timestamp: new Date('2024-01-15T10:00:02Z') }),
        makeEntry({ timestamp: new Date('2024-01-15T10:00:03Z') }),
        makeEntry({ timestamp: new Date('2024-01-15T10:05:00Z') }), // Far apart
      ];

      const groups = groupByTime(entries, 5000);
      expect(groups.size).toBe(2);
    });

    it('handles empty input', () => {
      const groups = groupByTime([]);
      expect(groups.size).toBe(0);
    });
  });

  describe('groupEntries (combined)', () => {
    it('absorbs nearby entries into ID groups, remaining go to time groups', () => {
      const entries = [
        makeEntry({ requestId: 'req-1', timestamp: new Date('2024-01-15T10:00:00Z') }),
        makeEntry({ requestId: 'req-1', timestamp: new Date('2024-01-15T10:00:01Z') }),
        makeEntry({ timestamp: new Date('2024-01-15T10:00:00Z') }), // No ID, absorbed into req-1 (within 2s)
        makeEntry({ timestamp: new Date('2024-01-15T10:00:02Z') }), // No ID, absorbed into req-1 (within 2s)
      ];

      const result = groupEntries(entries);
      expect(result.stats.byId).toBe(1);
      // All entries absorbed into the ID group since they're within 2s
      expect(result.stats.totalGroups).toBe(1);
    });

    it('keeps distant entries in separate time groups', () => {
      const entries = [
        makeEntry({ requestId: 'req-1', timestamp: new Date('2024-01-15T10:00:00Z') }),
        makeEntry({ requestId: 'req-1', timestamp: new Date('2024-01-15T10:00:01Z') }),
        makeEntry({ timestamp: new Date('2024-01-15T10:10:00Z') }), // 10 min later, can't absorb
      ];

      const result = groupEntries(entries);
      expect(result.stats.byId).toBe(1);
      expect(result.stats.byTime).toBe(1);
      expect(result.stats.totalGroups).toBe(2);
    });
  });
});
