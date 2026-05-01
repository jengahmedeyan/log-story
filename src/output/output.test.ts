import { describe, it, expect } from 'vitest';
import { formatCLI } from './cli-formatter.js';
import { formatJSON } from './json-formatter.js';
import { formatTimeline } from './timeline.js';
import type { AnalysisResult, StoryUnit, LogEvent, LogEntry } from '../types/index.js';

describe('Output Formatters', () => {
  const mockEntry: LogEntry = {
    timestamp: new Date('2026-05-01T10:00:00Z'),
    level: 'info',
    message: 'User logged in',
    metadata: {},
    raw: 'User logged in',
  };

  const mockEvent: LogEvent = {
    id: 'evt-1',
    entries: [mockEntry],
    groupKey: 'req-123',
    groupType: 'request',
    startTime: new Date('2026-05-01T10:00:00Z'),
    endTime: new Date('2026-05-01T10:00:01Z'),
    duration: 1000,
    actions: [{ type: 'login', status: 'completed' }],
    outcome: 'success',
    dependencies: [],
  };

  const mockStory: StoryUnit = {
    id: 'story-1',
    title: 'User Authentication',
    events: [mockEvent],
    causalChain: [],
    narrative: 'User successfully authenticated with the system',
    rootCause: undefined,
    impact: undefined,
    recommendation: undefined,
    severity: 'info',
    outcome: 'success',
    startTime: new Date('2026-05-01T10:00:00Z'),
    endTime: new Date('2026-05-01T10:00:01Z'),
    duration: 1000,
    actors: ['user-123'],
    services: ['auth-service'],
  };

  const mockResult: AnalysisResult = {
    storyUnits: [mockStory],
    insights: [
      {
        type: 'pattern',
        title: 'High success rate',
        description: 'All authentication attempts succeeded',
        occurrences: 1,
        timeRange: {
          start: new Date('2026-05-01T10:00:00Z'),
          end: new Date('2026-05-01T10:00:01Z'),
        },
        relatedEvents: ['evt-1'],
        severity: 'low',
      },
    ],
    systemSummary: '1 distinct operations detected. All operations completed successfully.',
    stats: {
      totalEntries: 1,
      groupsFound: 1,
      eventsExtracted: 1,
      storiesGenerated: 1,
      errorsDetected: 0,
      aiCallsMade: 0,
      estimatedCost: 0,
      processingTimeMs: 50,
    },
    events: [mockEvent],
  };

  describe('CLI Formatter', () => {
    it('should format basic analysis result', () => {
      const output = formatCLI(mockResult);
      expect(output).toContain('LOG STORY ANALYSIS');
      expect(output).toContain('1 stories from 1 log entries');
      expect(output).toContain('User Authentication');
      expect(output).toContain('User successfully authenticated with the system');
    });

    it('should include insights section when present', () => {
      const output = formatCLI(mockResult);
      expect(output).toContain('INSIGHTS');
      expect(output).toContain('High success rate');
      expect(output).toContain('All authentication attempts succeeded');
    });

    it('should show stats footer', () => {
      const output = formatCLI(mockResult);
      expect(output).toContain('50ms');
      expect(output).toContain('$0.0000');
      expect(output).toContain('0 calls');
    });

    it('should display root cause for failed stories', () => {
      const failedStory: StoryUnit = {
        ...mockStory,
        outcome: 'failure',
        severity: 'critical',
        rootCause: 'Database connection timeout',
        recommendation: 'Check database connectivity',
      };

      const failedResult = {
        ...mockResult,
        storyUnits: [failedStory],
      };

      const output = formatCLI(failedResult);
      expect(output).toContain('Database connection timeout');
      expect(output).toContain('Check database connectivity');
    });

    it('should show actors and services', () => {
      const output = formatCLI(mockResult);
      expect(output).toContain('user-123');
      expect(output).toContain('auth-service');
    });
  });

  describe('JSON Formatter', () => {
    it('should produce valid JSON', () => {
      const output = formatJSON(mockResult);
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should include all story fields', () => {
      const output = formatJSON(mockResult);
      const parsed = JSON.parse(output);

      expect(parsed.stories).toHaveLength(1);
      expect(parsed.stories[0]).toMatchObject({
        id: 'story-1',
        title: 'User Authentication',
        severity: 'info',
        outcome: 'success',
        narrative: 'User successfully authenticated with the system',
        actors: ['user-123'],
        services: ['auth-service'],
      });
    });

    it('should include insights', () => {
      const output = formatJSON(mockResult);
      const parsed = JSON.parse(output);

      expect(parsed.insights).toHaveLength(1);
      expect(parsed.insights[0]).toMatchObject({
        type: 'pattern',
        severity: 'low',
        title: 'High success rate',
        occurrences: 1,
      });
    });

    it('should include summary and stats', () => {
      const output = formatJSON(mockResult);
      const parsed = JSON.parse(output);

      expect(parsed.summary).toBe('1 distinct operations detected. All operations completed successfully.');
      expect(parsed.stats).toMatchObject({
        totalEntries: 1,
        storiesGenerated: 1,
        processingTimeMs: 50,
      });
    });

    it('should format timestamps as ISO strings', () => {
      const output = formatJSON(mockResult);
      const parsed = JSON.parse(output);

      expect(parsed.stories[0].timeRange.start).toBe('2026-05-01T10:00:00.000Z');
      expect(parsed.stories[0].timeRange.end).toBe('2026-05-01T10:00:01.000Z');
    });
  });

  describe('Timeline Formatter', () => {
    it('should format single-entry events', () => {
      const output = formatTimeline([mockStory]);
      expect(output).toContain('User logged in');
      expect(output).toContain('──'); // Single entry connector
    });

    it('should format multi-entry events with tree structure', () => {
      const multiEntry: LogEntry[] = [
        { ...mockEntry, message: 'Request received' },
        { ...mockEntry, message: 'Processing data', timestamp: new Date('2026-05-01T10:00:00.500Z') },
        { ...mockEntry, message: 'Response sent', timestamp: new Date('2026-05-01T10:00:01Z') },
      ];

      const multiEventStory: StoryUnit = {
        ...mockStory,
        events: [{
          ...mockEvent,
          entries: multiEntry,
        }],
      };

      const output = formatTimeline([multiEventStory]);
      expect(output).toContain('┬─'); // Start
      expect(output).toContain('├─'); // Middle
      expect(output).toContain('└─'); // End
      expect(output).toContain('Request received');
      expect(output).toContain('Processing data');
      expect(output).toContain('Response sent');
    });

    it('should include outcome symbols', () => {
      const output = formatTimeline([mockStory]);
      expect(output).toMatch(/✓|✗|\?/); // Should contain success/failure/unknown symbol
    });

    it('should separate stories with blank lines', () => {
      const output = formatTimeline([mockStory, mockStory]);
      const lines = output.split('\n');
      expect(lines.some(line => line === '')).toBe(true);
    });
  });
});
