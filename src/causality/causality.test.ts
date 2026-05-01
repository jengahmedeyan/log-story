import { describe, it, expect } from 'vitest';
import { buildStoryUnits } from './story-builder.js';
import type { LogEvent, LogEntry } from '../types/index.js';

function makeEntry(overrides?: Partial<LogEntry>): LogEntry {
  return {
    timestamp: new Date('2024-01-15T10:00:00Z'),
    level: 'info',
    message: 'test',
    metadata: {},
    raw: 'test',
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<LogEvent>): LogEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    entries: [makeEntry()],
    groupKey: 'grp-1',
    groupType: 'request',
    startTime: new Date('2024-01-15T10:00:00Z'),
    endTime: new Date('2024-01-15T10:00:01Z'),
    duration: 1000,
    actions: [],
    outcome: 'success',
    dependencies: [],
    ...overrides,
  };
}

describe('Story Builder', () => {
  describe('basic story generation', () => {
    it('converts a single event into a story unit', () => {
      const events = [makeEvent()];
      const stories = buildStoryUnits(events);

      expect(stories).toHaveLength(1);
      expect(stories[0].events).toHaveLength(1);
      expect(stories[0].outcome).toBe('success');
      expect(stories[0].severity).toBe('info');
      expect(stories[0].narrative).toBeTruthy();
    });

    it('generates title for checkout flow', () => {
      const events = [
        makeEvent({
          entries: [
            makeEntry({ message: 'POST /checkout started' }),
            makeEntry({ message: 'payment processing' }),
          ],
          outcome: 'success',
        }),
      ];
      const stories = buildStoryUnits(events);
      expect(stories[0].title.toLowerCase()).toContain('checkout');
    });

    it('generates title for auth flow', () => {
      const events = [
        makeEvent({
          entries: [
            makeEntry({ message: 'User login attempt' }),
            makeEntry({ message: 'Auth success, session created' }),
          ],
          outcome: 'success',
        }),
      ];
      const stories = buildStoryUnits(events);
      expect(stories[0].title.toLowerCase()).toMatch(/login|auth/);
    });

    it('generates title for failure events', () => {
      const events = [
        makeEvent({
          entries: [
            makeEntry({ level: 'error', message: 'Payment timeout' }),
          ],
          outcome: 'failure',
          actions: [{ type: 'api_call', target: 'payment-api', status: 'failed' }],
        }),
      ];
      const stories = buildStoryUnits(events);
      expect(stories[0].outcome).toBe('failure');
      expect(stories[0].severity).not.toBe('info');
    });
  });

  describe('causal chain detection', () => {
    it('links events from same user into one story', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({ userId: 'user-42', message: 'Login started' })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:01Z'),
          outcome: 'success',
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ userId: 'user-42', message: 'Checkout started' })],
          startTime: new Date('2024-01-15T10:00:05Z'),
          endTime: new Date('2024-01-15T10:00:06Z'),
          outcome: 'success',
        }),
      ];

      const stories = buildStoryUnits(events);
      // Should merge into a single story (same user, close in time)
      expect(stories.length).toBeLessThanOrEqual(1);
      if (stories.length === 1) {
        expect(stories[0].events.length).toBe(2);
        expect(stories[0].actors).toContain('user-42');
      }
    });

    it('links events with shared sessionId', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({ sessionId: 'sess-abc', message: 'Page load' })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:01Z'),
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ sessionId: 'sess-abc', message: 'Form submit' })],
          startTime: new Date('2024-01-15T10:00:30Z'),
          endTime: new Date('2024-01-15T10:00:31Z'),
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories.length).toBe(1);
      expect(stories[0].events.length).toBe(2);
    });

    it('keeps unrelated events as separate stories', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({ userId: 'user-1', message: 'Login' })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:01Z'),
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ userId: 'user-2', message: 'Signup' })],
          startTime: new Date('2024-01-15T10:05:00Z'),
          endTime: new Date('2024-01-15T10:05:01Z'),
        }),
      ];

      const stories = buildStoryUnits(events);
      // Different users, 5 min apart → separate stories
      expect(stories.length).toBe(2);
    });

    it('links events with shared entity references', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({
            message: 'Order created',
            metadata: { orderId: 'order-999' },
          })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:01Z'),
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({
            message: 'Payment processed',
            metadata: { orderId: 'order-999' },
          })],
          startTime: new Date('2024-01-15T10:00:10Z'),
          endTime: new Date('2024-01-15T10:00:11Z'),
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories.length).toBe(1);
      expect(stories[0].events.length).toBe(2);
    });
  });

  describe('outcome and severity', () => {
    it('marks failure when last event fails', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({ userId: 'u1', message: 'Start checkout' })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:01Z'),
          outcome: 'success',
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ userId: 'u1', level: 'error', message: 'Payment failed' })],
          startTime: new Date('2024-01-15T10:00:02Z'),
          endTime: new Date('2024-01-15T10:00:03Z'),
          outcome: 'failure',
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories[0].outcome).toBe('failure');
      expect(stories[0].severity).not.toBe('info');
    });

    it('marks partial when failure followed by recovery', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({ userId: 'u1', level: 'error', message: 'Payment timeout' })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:01Z'),
          outcome: 'failure',
          actions: [{ type: 'api_call', status: 'failed' }],
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ userId: 'u1', message: 'Retry succeeded' })],
          startTime: new Date('2024-01-15T10:00:05Z'),
          endTime: new Date('2024-01-15T10:00:06Z'),
          outcome: 'success',
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories[0].outcome).toBe('partial');
    });

    it('sets critical severity for retries with failures', () => {
      const events = [
        makeEvent({
          outcome: 'failure',
          actions: [
            { type: 'api_call', status: 'retried' },
            { type: 'api_call', status: 'failed' },
          ],
          entries: [makeEntry({ level: 'error', message: 'All retries failed' })],
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories[0].severity).toBe('critical');
    });
  });

  describe('narrative generation', () => {
    it('generates checkout narrative', () => {
      const events = [
        makeEvent({
          entries: [
            makeEntry({ userId: 'u1', message: 'Checkout started' }),
            makeEntry({ userId: 'u1', message: 'Payment provider=stripe amount=49.99' }),
            makeEntry({ userId: 'u1', level: 'error', message: 'Payment timeout' }),
          ],
          outcome: 'failure',
          actions: [{ type: 'api_call', target: 'stripe', status: 'failed' }],
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories[0].narrative.toLowerCase()).toContain('checkout');
    });

    it('generates auth narrative', () => {
      const events = [
        makeEvent({
          entries: [
            makeEntry({ userId: 'u1', message: 'User login request' }),
            makeEntry({ userId: 'u1', message: 'Auth success, session created' }),
          ],
          outcome: 'success',
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories[0].narrative.toLowerCase()).toMatch(/log.*in|auth/);
    });

    it('extracts root cause for failures', () => {
      const events = [
        makeEvent({
          entries: [
            makeEntry({ level: 'error', message: 'Connection timeout to payment-api provider=stripe' }),
          ],
          outcome: 'failure',
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories[0].rootCause).toBeTruthy();
      expect(stories[0].rootCause!.toLowerCase()).toContain('timeout');
    });

    it('generates recommendations for timeouts', () => {
      const events = [
        makeEvent({
          entries: [
            makeEntry({ level: 'error', message: 'Request timeout after 5000ms' }),
          ],
          outcome: 'failure',
        }),
      ];

      const stories = buildStoryUnits(events);
      expect(stories[0].recommendation).toBeTruthy();
      expect(stories[0].recommendation!.toLowerCase()).toContain('circuit breaker');
    });

    it('does not generate root cause for success', () => {
      const events = [makeEvent({ outcome: 'success' })];
      const stories = buildStoryUnits(events);
      expect(stories[0].rootCause).toBeUndefined();
    });
  });

  describe('story merging', () => {
    it('merges overlapping stories with shared actors', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({ userId: 'u1', message: 'Step 1' })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:10Z'),
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ userId: 'u1', message: 'Step 2' })],
          startTime: new Date('2024-01-15T10:00:05Z'),
          endTime: new Date('2024-01-15T10:00:15Z'),
        }),
      ];

      const stories = buildStoryUnits(events);
      // Overlapping + same user → merged
      expect(stories.length).toBe(1);
    });

    it('merges stories with shared services within time window', () => {
      const events = [
        makeEvent({
          id: 'evt-1',
          entries: [makeEntry({ message: 'api call' })],
          startTime: new Date('2024-01-15T10:00:00Z'),
          endTime: new Date('2024-01-15T10:00:01Z'),
          dependencies: ['payment-service'],
        }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ message: 'confirmation' })],
          startTime: new Date('2024-01-15T10:00:20Z'),
          endTime: new Date('2024-01-15T10:00:21Z'),
          dependencies: ['payment-service'],
        }),
      ];

      const stories = buildStoryUnits(events);
      // Same service + within 60s → merged
      expect(stories.length).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles empty events array', () => {
      const stories = buildStoryUnits([]);
      expect(stories).toHaveLength(0);
    });

    it('handles single event', () => {
      const stories = buildStoryUnits([makeEvent()]);
      expect(stories).toHaveLength(1);
    });

    it('produces sorted output', () => {
      const events = [
        makeEvent({
          id: 'evt-late',
          entries: [makeEntry({ userId: 'u-late', message: 'late' })],
          startTime: new Date('2024-01-15T11:00:00Z'),
          endTime: new Date('2024-01-15T11:00:01Z'),
        }),
        makeEvent({
          id: 'evt-early',
          entries: [makeEntry({ userId: 'u-early', message: 'early' })],
          startTime: new Date('2024-01-15T09:00:00Z'),
          endTime: new Date('2024-01-15T09:00:01Z'),
        }),
      ];

      const stories = buildStoryUnits(events);
      for (let i = 1; i < stories.length; i++) {
        expect(stories[i].startTime.getTime()).toBeGreaterThanOrEqual(
          stories[i - 1].startTime.getTime()
        );
      }
    });

    it('all stories have required fields', () => {
      const events = [
        makeEvent({ outcome: 'success' }),
        makeEvent({
          id: 'evt-2',
          entries: [makeEntry({ userId: 'u2', message: 'another' })],
          startTime: new Date('2024-01-15T12:00:00Z'),
          endTime: new Date('2024-01-15T12:00:01Z'),
        }),
      ];

      const stories = buildStoryUnits(events);
      for (const story of stories) {
        expect(story.id).toBeTruthy();
        expect(story.title).toBeTruthy();
        expect(story.narrative).toBeTruthy();
        expect(story.events.length).toBeGreaterThan(0);
        expect(story.causalChain.length).toBeGreaterThan(0);
        expect(['success', 'failure', 'partial', 'unknown']).toContain(story.outcome);
        expect(['info', 'warning', 'critical']).toContain(story.severity);
        expect(story.startTime).toBeInstanceOf(Date);
        expect(story.endTime).toBeInstanceOf(Date);
        expect(typeof story.duration).toBe('number');
      }
    });
  });
});
