import { describe, it, expect } from 'vitest';
import { LogStory, analyze } from './index.js';

describe('LogStory Integration', () => {
  it('analyzes simple plain text logs end-to-end', async () => {
    const input = `POST /checkout
calling payment API
retry payment API
timeout after 5000ms`;

    const result = await analyze(input);

    expect(result.storyUnits.length).toBeGreaterThan(0);
    expect(result.stats.totalEntries).toBe(4);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('analyzes JSON logs end-to-end', async () => {
    const input = `{"level":"info","message":"POST /checkout","timestamp":"2024-01-15T10:00:00Z","requestId":"req-1"}
{"level":"info","message":"calling payment API","timestamp":"2024-01-15T10:00:01Z","requestId":"req-1"}
{"level":"warn","message":"retry payment API","timestamp":"2024-01-15T10:00:03Z","requestId":"req-1"}
{"level":"error","message":"timeout after 5000ms","timestamp":"2024-01-15T10:00:05Z","requestId":"req-1"}`;

    const logStory = new LogStory();
    const result = await logStory.analyze(input);

    // All entries grouped by requestId → 1 event → 1 story
    expect(result.storyUnits.length).toBeGreaterThanOrEqual(1);
    expect(result.storyUnits[0].outcome).toBe('failure');
    expect(result.stats.errorsDetected).toBe(1);
  });

  it('groups by requestId correctly', async () => {
    const input = `{"level":"info","message":"User login","timestamp":"2024-01-15T10:00:00Z","requestId":"req-A"}
{"level":"info","message":"Fetch profile","timestamp":"2024-01-15T10:00:01Z","requestId":"req-A"}
{"level":"info","message":"Order placed","timestamp":"2024-01-15T10:00:00Z","requestId":"req-B"}
{"level":"error","message":"Payment failed","timestamp":"2024-01-15T10:00:02Z","requestId":"req-B"}`;

    const result = await analyze(input);
    expect(result.events).toHaveLength(2);
  });

  it('formats output as JSON', async () => {
    const input = `[2024-01-15T10:00:00Z] INFO: Server started`;
    const logStory = new LogStory({ output: { format: 'json' } });
    const result = await logStory.analyze(input);
    const output = logStory.format(result);

    const parsed = JSON.parse(output);
    expect(parsed.stories).toBeDefined();
    expect(parsed.insights).toBeDefined();
    expect(parsed.summary).toBeDefined();
  });

  it('works without AI (template-based)', async () => {
    const input = `{"level":"info","message":"POST /api/users","timestamp":"2024-01-15T10:00:00Z","requestId":"r1"}
{"level":"info","message":"User created successfully","timestamp":"2024-01-15T10:00:01Z","requestId":"r1"}`;

    const result = await analyze(input);
    expect(result.stats.aiCallsMade).toBe(0);
    expect(result.storyUnits[0].narrative.length).toBeGreaterThan(0);
  });

  it('generates insights for failures', async () => {
    const input = `{"level":"info","message":"POST /checkout","timestamp":"2024-01-15T10:00:00Z","requestId":"req-1"}
{"level":"error","message":"payment timeout provider=stripe","timestamp":"2024-01-15T10:00:05Z","requestId":"req-1"}
{"level":"error","message":"checkout failed","timestamp":"2024-01-15T10:00:06Z","requestId":"req-1"}`;

    const result = await analyze(input);
    expect(result.insights.length).toBeGreaterThan(0);
  });

  it('eliminates UNKNOWN outcomes', async () => {
    const input = `{"level":"info","message":"GET /products","timestamp":"2024-01-15T10:00:00Z","requestId":"r1"}
{"level":"info","message":"returned 25 products","timestamp":"2024-01-15T10:00:01Z","requestId":"r1"}`;

    const result = await analyze(input);
    const hasUnknown = result.storyUnits.some((s) => s.outcome === 'unknown');
    expect(hasUnknown).toBe(false);
  });
});
