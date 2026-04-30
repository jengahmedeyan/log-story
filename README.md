# log-story

Transform raw logs into human-readable narratives, structured timelines, and actionable insights.

## Install

```bash
npm install log-story
```

For AI-powered narratives, install an AI provider:

```bash
npm install openai                # For OpenAI
npm install @anthropic-ai/sdk     # For Anthropic
npm install @google/generative-ai # For Gemini
```

## Quick Start

```typescript
import { analyze } from 'log-story';

const logs = `
POST /checkout
calling payment API
retry payment API
timeout after 5000ms
`;

const result = await analyze(logs);
console.log(result.stories[0].narrative);
// → "The system attempted to call /checkout, then called the payment API
//    twice. Both attempts failed due to a timeout after 5 seconds."
```

## CLI Usage

```bash
# Set your API key (optional, for AI-powered narratives)
export LOG_STORY_API_KEY=sk-...           # Unix/Linux/macOS
$env:LOG_STORY_API_KEY = "sk-..."        # PowerShell

# Analyze a log file
npx log-story analyze app.log

# Pipe from another command
cat app.log | npx log-story analyze

# Query your logs
npx log-story query "why are payments failing?" --context app.log

# Output as JSON
npx log-story analyze app.log --format json

# Timeline view
npx log-story analyze app.log --format timeline

# Without AI (template-based summaries only)
npx log-story analyze app.log --no-ai
```

## Programmatic API

```typescript
import { LogStory } from 'log-story';

const logStory = new LogStory({
  ai: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
  },
  grouping: {
    timeWindow: 5000,
    fields: ['requestId', 'traceId'],
  },
  output: {
    format: 'cli',
  },
});

// Analyze string logs
const result = await logStory.analyze(logString);
console.log(logStory.format(result));

// Analyze JSON log objects
const result = await logStory.analyzeJSON(jsonLogs);

// Ask questions
const answer = await logStory.query('Why are checkouts failing?', result);
```

## Supported Log Formats

- **Winston JSON** — `{"level":"info","message":"...","timestamp":"..."}`
- **Pino JSON** — `{"level":30,"msg":"...","time":1234567890}`
- **Plain text** — `[timestamp] LEVEL: message`
- **Unstructured** — Raw text (timestamps inferred)

## Streaming (Large Files)

Process large log files without loading everything into memory:

```typescript
import { LogStory } from 'log-story';
import { createReadStream } from 'fs';

const logStory = new LogStory({
  streaming: {
    chunkSize: 1000,      // entries per chunk (default: 500)
    flushInterval: 5000,  // ms before flushing partial chunk (default: 5000)
    overlapSize: 50,      // entries overlapping between chunks for continuity
  },
});

const stream = logStory.createStream();
createReadStream('large-app.log').pipe(stream);

stream.on('story', (story) => {
  console.log(`[${story.outcome}] ${story.narrative}`);
});

stream.on('insight', (insight) => {
  console.log(`⚠️ ${insight.title}: ${insight.description}`);
});

stream.on('done', (stats) => {
  console.log(`Processed ${stats.totalEntries} entries, found ${stats.storiesGenerated} stories`);
});
```

Or use the standalone factory:

```typescript
import { createAnalysisStream } from 'log-story';

const stream = createAnalysisStream({ streaming: { chunkSize: 2000 } });
process.stdin.pipe(stream);
```

## Grouping Strategies

log-story uses a multi-pass grouping algorithm:

1. **ID-based** — Groups by `requestId`, `traceId`, `userId`, `sessionId`
2. **Absorption** — Absorbs nearby ungrouped entries into existing ID groups
3. **Inference** — Clusters remaining entries by content similarity (keyword Jaccard distance)
4. **Time-window** — Groups remaining entries within configurable time proximity

Control via CLI:

```bash
log-story analyze app.log --group-by request   # Only requestId/traceId
log-story analyze app.log --group-by user      # Only userId/sessionId
log-story analyze app.log --group-by time      # Time proximity only
log-story analyze app.log --group-by auto      # All strategies (default)
```

Or programmatically:

```typescript
const logStory = new LogStory({
  grouping: {
    timeWindow: 10000,  // 10s window
    fields: ['requestId', 'traceId', 'orderId'],  // Custom fields to group by
  },
});
```

## AI Providers

| Provider | Model Default | Install |
|----------|--------------|---------|
| OpenAI | `gpt-4o-mini` | `npm i openai` |
| Anthropic | `claude-sonnet-4-20250514` | `npm i @anthropic-ai/sdk` |
| Gemini | `gemini-2.0-flash` | `npm i @google/generative-ai` |
| Local | — (template-based) | Built-in, no install needed |

```typescript
// Use local provider for zero-cost, offline analysis
const logStory = new LogStory({ ai: { provider: 'local' } });
```

AI calls include automatic:
- **Response caching** — Identical event signatures return cached results (24h TTL)
- **Retry with backoff** — Transient failures (429, 5xx, timeouts) auto-retry up to 3 times

## Integration: Winston Transport

```typescript
import winston from 'winston';
import { LogStory } from 'log-story';

// Buffer logs and analyze periodically
const logStory = new LogStory({ ai: { provider: 'local' } });
const buffer: string[] = [];

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new winston.transports.Stream({
      stream: new (require('stream').Writable)({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          buffer.push(chunk.toString());
          if (buffer.length >= 100) {
            logStory.analyze(buffer.splice(0).join('\n'))
              .then(r => r.storyUnits.forEach(s => console.log(s.narrative)));
          }
          cb();
        },
      }),
    }),
  ],
});
```

## Integration: Pino Transport

```typescript
import pino from 'pino';
import { createAnalysisStream } from 'log-story';
import { Transform } from 'stream';

// Create a transport that feeds into log-story
const analysisStream = createAnalysisStream({ streaming: { chunkSize: 50 } });
analysisStream.on('story', (story) => {
  console.error(`[log-story] ${story.narrative}`);
});

const transport = new Transform({
  transform(chunk, _enc, cb) {
    analysisStream.write(chunk);
    cb(null, chunk); // pass through to stdout
  },
});

const logger = pino(transport);
```

## How It Works

1. **Parse** — Auto-detect format and normalize to structured entries
2. **Group** — Cluster related logs by ID, content similarity, or time proximity
3. **Extract** — Build structured events with actions, outcomes, and durations
4. **Narrate** — Generate human-readable explanations (template or AI-powered)
5. **Causality** — Link events into causal chains and detect flows
6. **Insights** — Detect patterns, anomalies, and recurring failures
7. **Output** — Format for CLI, JSON, or timeline display

## Works Without AI

log-story generates useful template-based summaries without any AI provider. AI enhances narratives for complex events but isn't required.

```bash
# No API key needed
npx log-story analyze app.log --no-ai
```

## API Reference

### `LogStory` Class

| Method | Description |
|--------|-------------|
| `analyze(input: string)` | Analyze raw log text |
| `analyzeJSON(logs: object[])` | Analyze JSON log objects |
| `query(question, context)` | Ask a natural language question |
| `createStream()` | Create a streaming analysis pipeline |
| `format(result)` | Format results for display |

### `AnalysisResult`

```typescript
interface AnalysisResult {
  storyUnits: StoryUnit[];   // Causal stories with narratives
  insights: Insight[];        // Detected patterns and anomalies
  systemSummary: string;      // One-line system health summary
  stats: AnalysisStats;       // Processing statistics
  events: LogEvent[];
}
```

## License

MIT
