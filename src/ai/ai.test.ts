import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AIProvider, LogEvent, StoryUnit } from '../types/index.js';
import { withCache, clearCache } from './cache.js';
import { withRetryBackoff } from './retry.js';
import { create as createLocal } from './local.js';

function makeEvent(overrides?: Partial<LogEvent>): LogEvent {
  return {
    id: 'evt-1',
    entries: [
      {
        timestamp: new Date('2024-01-15T10:00:00Z'),
        level: 'info',
        message: 'Test message',
        metadata: {},
        raw: 'Test message',
      },
    ],
    groupKey: 'req-1',
    groupType: 'request',
    startTime: new Date('2024-01-15T10:00:00Z'),
    endTime: new Date('2024-01-15T10:00:01Z'),
    duration: 1000,
    actions: [{ type: 'api_call', target: '/api/test', status: 'completed' }],
    outcome: 'success',
    dependencies: ['test-service'],
    ...overrides,
  };
}

function makeFailedEvent(): LogEvent {
  return makeEvent({
    id: 'evt-fail',
    outcome: 'failure',
    entries: [
      {
        timestamp: new Date('2024-01-15T10:00:00Z'),
        level: 'error',
        message: 'Connection timeout after 5000ms',
        metadata: {},
        raw: 'Connection timeout after 5000ms',
      },
    ],
    actions: [{ type: 'api_call', target: 'payment-api', status: 'failed', error: 'timeout' }],
  });
}

function makeMockProvider(): AIProvider {
  return {
    generateNarrative: vi.fn().mockResolvedValue('Test narrative'),
    generateRootCause: vi.fn().mockResolvedValue('Test root cause'),
    answerQuery: vi.fn().mockResolvedValue('Test answer'),
    estimateCost: vi.fn().mockReturnValue(0.001),
  };
}

// ─── Cache Tests ────────────────────────────────────────────────

describe('AI Cache', () => {
  beforeEach(() => {
    clearCache();
  });

  it('caches narrative responses for identical events', async () => {
    const mock = makeMockProvider();
    const cached = withCache(mock);

    const event = makeEvent();
    const result1 = await cached.generateNarrative(event);
    const result2 = await cached.generateNarrative(event);

    expect(result1).toBe('Test narrative');
    expect(result2).toBe('Test narrative');
    // Should only call the underlying provider once
    expect(mock.generateNarrative).toHaveBeenCalledTimes(1);
  });

  it('caches root cause responses', async () => {
    const mock = makeMockProvider();
    const cached = withCache(mock);

    const event = makeFailedEvent();
    await cached.generateRootCause(event);
    await cached.generateRootCause(event);

    expect(mock.generateRootCause).toHaveBeenCalledTimes(1);
  });

  it('does not cache query responses', async () => {
    const mock = makeMockProvider();
    const cached = withCache(mock);

    await cached.answerQuery('why?', []);
    await cached.answerQuery('why?', []);

    expect(mock.answerQuery).toHaveBeenCalledTimes(2);
  });

  it('returns different results for different event signatures', async () => {
    const mock = makeMockProvider();
    (mock.generateNarrative as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('narrative-1')
      .mockResolvedValueOnce('narrative-2');

    const cached = withCache(mock);

    const event1 = makeEvent({ outcome: 'success' });
    const event2 = makeEvent({
      outcome: 'failure',
      actions: [{ type: 'db_operation', status: 'failed' }],
    });

    const r1 = await cached.generateNarrative(event1);
    const r2 = await cached.generateNarrative(event2);

    expect(r1).toBe('narrative-1');
    expect(r2).toBe('narrative-2');
    expect(mock.generateNarrative).toHaveBeenCalledTimes(2);
  });

  it('passes through estimateCost', () => {
    const mock = makeMockProvider();
    const cached = withCache(mock);
    expect(cached.estimateCost(1000)).toBe(0.001);
  });
});

// ─── Retry Tests ────────────────────────────────────────────────

describe('AI Retry', () => {
  it('succeeds on first attempt without retry', async () => {
    const mock = makeMockProvider();
    const retried = withRetryBackoff(mock);

    const result = await retried.generateNarrative(makeEvent());
    expect(result).toBe('Test narrative');
    expect(mock.generateNarrative).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 rate limit', async () => {
    const mock = makeMockProvider();
    (mock.generateNarrative as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ status: 429, message: 'Rate limited' })
      .mockResolvedValueOnce('recovered');

    const retried = withRetryBackoff(mock, { initialDelay: 10, maxRetries: 3 });
    const result = await retried.generateNarrative(makeEvent());

    expect(result).toBe('recovered');
    expect(mock.generateNarrative).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 server error', async () => {
    const mock = makeMockProvider();
    (mock.generateNarrative as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce('recovered after 503');

    const retried = withRetryBackoff(mock, { initialDelay: 10, maxRetries: 3 });
    const result = await retried.generateNarrative(makeEvent());

    expect(result).toBe('recovered after 503');
    expect(mock.generateNarrative).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 401 auth error', async () => {
    const mock = makeMockProvider();
    (mock.generateNarrative as ReturnType<typeof vi.fn>)
      .mockRejectedValue({ status: 401, message: 'Unauthorized' });

    const retried = withRetryBackoff(mock, { initialDelay: 10, maxRetries: 3 });
    await expect(retried.generateNarrative(makeEvent())).rejects.toEqual({
      status: 401,
      message: 'Unauthorized',
    });
    expect(mock.generateNarrative).toHaveBeenCalledTimes(1);
  });

  it('gives up after max retries', async () => {
    const mock = makeMockProvider();
    (mock.generateNarrative as ReturnType<typeof vi.fn>)
      .mockRejectedValue({ status: 429 });

    const retried = withRetryBackoff(mock, { initialDelay: 10, maxRetries: 2 });
    await expect(retried.generateNarrative(makeEvent())).rejects.toEqual({ status: 429 });
    expect(mock.generateNarrative).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries connection errors', async () => {
    const mock = makeMockProvider();
    (mock.generateNarrative as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValueOnce('reconnected');

    const retried = withRetryBackoff(mock, { initialDelay: 10 });
    const result = await retried.generateNarrative(makeEvent());
    expect(result).toBe('reconnected');
  });

  it('retries answerQuery as well', async () => {
    const mock = makeMockProvider();
    (mock.answerQuery as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValueOnce('query answer');

    const retried = withRetryBackoff(mock, { initialDelay: 10 });
    const result = await retried.answerQuery('test', []);
    expect(result).toBe('query answer');
  });
});

// ─── Local Provider Tests ───────────────────────────────────────

describe('Local AI Provider', () => {
  it('generates narrative for success event', async () => {
    const local = createLocal();
    const narrative = await local.generateNarrative(makeEvent());

    expect(narrative).toContain('api_call');
    expect(narrative).toContain('/api/test');
    expect(narrative).toContain('1.0s');
  });

  it('generates narrative for failure event', async () => {
    const local = createLocal();
    const narrative = await local.generateNarrative(makeFailedEvent());

    expect(narrative).toContain('failed');
    expect(narrative).toContain('timeout');
  });

  it('generates root cause for timeout', async () => {
    const local = createLocal();
    const cause = await local.generateRootCause(makeFailedEvent());

    expect(cause).toContain('Timeout');
    expect(cause).toContain('overloaded');
  });

  it('generates root cause for connection error', async () => {
    const local = createLocal();
    const event = makeEvent({
      outcome: 'failure',
      entries: [{
        timestamp: new Date(),
        level: 'error',
        message: 'ECONNREFUSED 127.0.0.1:5432',
        metadata: {},
        raw: 'ECONNREFUSED',
      }],
    });
    const cause = await local.generateRootCause(event);
    expect(cause).toContain('Connection failure');
  });

  it('answers failure queries', async () => {
    const local = createLocal();
    const stories: StoryUnit[] = [
      {
        id: '1', title: 'Payment failed', events: [makeFailedEvent()],
        causalChain: [], narrative: 'Payment failed', severity: 'critical',
        outcome: 'failure', startTime: new Date(), endTime: new Date(),
        duration: 1000, actors: [], services: [],
      },
    ];
    const answer = await local.answerQuery('why did it fail?', stories);
    expect(answer).toContain('failure');
    expect(answer).toContain('Payment failed');
  });

  it('answers performance queries', async () => {
    const local = createLocal();
    const stories: StoryUnit[] = [
      {
        id: '1', title: 'Slow query', events: [makeEvent({ duration: 5000 })],
        causalChain: [], narrative: 'Slow query', severity: 'info',
        outcome: 'success', startTime: new Date(), endTime: new Date(),
        duration: 5000, actors: [], services: [],
      },
    ];
    const answer = await local.answerQuery('what is slow?', stories);
    expect(answer).toContain('Slowest');
    expect(answer).toContain('Slow query');
  });

  it('has zero cost', () => {
    const local = createLocal();
    expect(local.estimateCost(10000)).toBe(0);
  });
});
