# log-story

A Node.js application log analyser. Reads structured logs from Pino, Winston, Bunyan, or Morgan and groups related entries into named stories — a login flow, a failed job, a deployment, a payment timeout — with narrative summaries, outcomes, root causes, and recommendations.

**Not a general-purpose log tool.** log-story is built specifically for Node.js application logs. It does not support syslog, journald, kernel logs, or logs from non-Node.js applications. If the input doesn't match a supported format, the tool exits with a clear error rather than producing wrong results.

## Quick Start

No install required for one-off use:

```bash
npx log-story analyze app.log
```

Or install as a project dependency for the programmatic API:

```bash
npm install log-story
```

Example output:

```
✔ Analysis complete — 8 stories found

  LOG STORY ANALYSIS
  8 stories from 94 log entries

  ● STORY 1  Successful Login Flow
     08:14:03 → 08:14:03  (215ms)  [✓]
     User 8821 successfully logged in.
     Users: 8821  │  Services: /api/v2/auth/login

  ● STORY 2  Background Job – Retry Chain
     08:14:58 → 08:20:58  (360s)  [!]
     Background job 'send_bulk_email' failed twice then succeeded. 4,201 emails queued.

  ● STORY 3  Failed Checkout – Timeout
     08:22:34 → 08:22:34  (9ms)  [✗]
     User 10043 attempted checkout but payment failed.
     Root Cause: Stripe API did not respond within 2000ms
     Impact: Service degradation — requests returning errors to clients
     Recommendation: Consider implementing a circuit breaker pattern
     Users: 10043  │  Services: /api/v2/payments

  ● STORY 4  Deployment
     09:01:44 → 09:03:01  (54.8s)  [✓]
     Rolling deployment from v3.14.3 to v3.15.0. Zero-downtime rolling update.

  ────────────────────────────────────────────────────────────

  Summary: 8 stories. 1 failure, 1 warning, 6 successful.
  Time: 91ms  │  AI: $0.0000 (0 calls)  │  Unparsed: 0 lines
```

## AI Mode

Set `LOG_STORY_API_KEY` and log-story becomes a conversational analyst for your logs. Instead of reading through hundreds of entries, ask questions directly:

```bash
export LOG_STORY_API_KEY=sk-ant-...
npx log-story query "why did requests spike at 3am?" --context app.log
npx log-story query "show me everything that affected user 8821" --context app.log
```

Without AI, log-story still produces full story output using heuristic templates. AI mode improves two things: narrative quality for stories that don't match a known flow template, and root-cause explanations for failures. The `query` command is AI-only — it requires a key.

Supports three providers, auto-detected from the key prefix:

```bash
export LOG_STORY_API_KEY=sk-ant-...   # Anthropic
export LOG_STORY_API_KEY=sk-...       # OpenAI
export LOG_STORY_API_KEY=AIza...      # Gemini
```

Costs a few cents per run depending on log size. Includes response caching (24h TTL) and automatic retry with backoff for rate limits.

## Supported Formats

log-story auto-detects the format from the file content. Only these four are supported:

| Format | Shape |
|--------|-------|
| **Pino** | `{"level":30,"time":1714600000000,"msg":"request completed"}` |
| **Winston** | `{"level":"info","message":"server started","timestamp":"2026-05-01T00:00:01.000Z"}` |
| **Bunyan** | `{"v":0,"level":30,"msg":"listening","time":"2026-05-01T00:00:01.000Z"}` |
| **Morgan** | `::ffff:127.0.0.1 - - [01/May/2026:08:14:03 +0000] "GET /health HTTP/1.1" 200 15` |

If the input doesn't match one of these formats (less than 70% of sampled lines parse successfully), log-story exits with an error and reports the confidence score. Use `--debug-parse` to inspect which lines failed.

## How It Works

1. **Parse** — Auto-detect format, parse each line into structured entries with timestamp, level, message, and metadata. Lines that don't match are discarded and counted as unparsed.

2. **Group** — Cluster related entries by correlation IDs (`requestId`, `traceId`, `userId`, `sessionId`, `jobId`), then by content similarity, then by time proximity. Entries that don't fit any group are analysed individually.

3. **Extract** — Build structured events from each group: detect actions (API calls, auth events, DB operations), determine outcomes (success/failure/partial), extract durations and actors.

4. **Build Stories** — Match groups to known flow templates (auth, checkout, deployment, background job, scheduled task) or generate heuristic narratives from the content. Detect causal chains and assign root causes.

5. **Insights** — Surface cross-story patterns: recurring failures, performance degradation, anomalies.

## CLI Options

```bash
npx log-story analyze <file> [options]
```

| Flag | Description |
|------|-------------|
| `--no-ai` | Run without AI — uses heuristic templates only (default if no API key set) |
| `--format <fmt>` | Output format: `cli` (default), `json`, `timeline` |
| `--debug-parse` | Print unmatched lines to stderr with failure context |
| `--level <levels>` | Filter by log level before analysis (comma-separated: `error,warn`) |
| `--after <datetime>` | Include only entries after this ISO 8601 timestamp |
| `--before <datetime>` | Include only entries before this timestamp |
| `--user <id>` | Filter to entries for a specific user ID |
| `--request-id <id>` | Filter to entries for a specific request/trace ID |
| `--group-by <strategy>` | Grouping strategy: `auto` (default), `request`, `user`, `time` |
| `-v, --verbose` | Show detailed output |

## Programmatic API

```typescript
import { LogStory } from 'log-story';

const logStory = new LogStory({
  ai: {
    provider: 'anthropic',
    apiKey: process.env.LOG_STORY_API_KEY,
  },
});

const result = await logStory.analyze(logString);
console.log(logStory.format(result));
// result.storyUnits — array of stories with narrative, outcome, rootCause, etc.
// result.stats — processing stats (entries parsed, stories found, AI cost)
```

Without AI:

```typescript
const logStory = new LogStory(); // no config needed
const result = await logStory.analyze(logString);
```

## Limitations

- **Four formats only.** Pino, Winston, Bunyan, Morgan. Other formats (syslog, structured text, custom JSON schemas) are not supported and will be rejected.
- **Heuristic narratives are imprecise for custom flows.** Stories that don't match a known template (auth, checkout, jobs, deployments) get a best-effort narrative marked `[heuristic]`. AI mode improves these.
- **Not benchmarked at scale.** The tool works well up to ~50k lines. Behaviour on 100k+ line files has not been tested — use streaming mode for large files.
- **Not for system logs.** syslog, journald, kernel messages, security audit logs, and logs from non-Node.js processes are explicitly out of scope.
- **Grouping is best-effort.** Logs without correlation IDs (requestId, traceId) fall back to time-proximity and content-similarity grouping, which may produce incorrect clusters.

## Contributing

log-story is in beta. The most valuable contribution right now is real-world log samples (anonymised) shared via GitHub issues — they help improve format detection, grouping accuracy, and narrative quality for flows the heuristic path doesn't handle well yet.

## License

MIT
