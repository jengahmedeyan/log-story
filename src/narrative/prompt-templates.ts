import type { LogEvent, RedactionConfig } from '../types/index.js';
import { redactPII } from '../parser/redaction.js';

export function narrativePrompt(event: LogEvent, redactionConfig?: RedactionConfig): string {
  const shouldRedact = redactionConfig?.enabled ?? false;

  const actionsList = event.actions
    .map((a) => {
      const targetStr = a.target ? ` → ${a.target}` : '';
      const errorStr = a.error ? ` (${a.error})` : '';
      const line = `- ${a.type}${targetStr} [${a.status}]${errorStr}`;
      return shouldRedact ? redactPII(line, redactionConfig) : line;
    })
    .join('\n');

  const entrySummary = event.entries
    .slice(0, 15) // Limit to keep prompt small
    .map((e) => {
      const line = `  [${e.level.toUpperCase()}] ${e.message}`;
      return shouldRedact ? redactPII(line, redactionConfig) : line;
    })
    .join('\n');

  return `You are a system behavior analyst. Given the following structured event data, write a 1-3 sentence explanation of what happened in plain English.

Event:
- Time: ${event.startTime.toISOString()} to ${event.endTime.toISOString()} (${event.duration}ms)
- Outcome: ${event.outcome}
- Actions detected:
${actionsList || '  (none detected)'}

Raw log messages:
${entrySummary}

Rules:
- Be specific about what failed and why
- Mention timing if relevant (timeouts, slow responses)
- Use active voice
- Do not speculate beyond the data
- Keep it to 1-3 sentences`;
}

export function rootCausePrompt(event: LogEvent, redactionConfig?: RedactionConfig): string {
  const shouldRedact = redactionConfig?.enabled ?? false;

  const entrySummary = event.entries
    .filter((e) => e.level === 'error' || e.level === 'warn' || e.level === 'fatal')
    .map((e) => {
      const line = `  [${e.level.toUpperCase()}] ${e.message}`;
      return shouldRedact ? redactPII(line, redactionConfig) : line;
    })
    .join('\n');

  const allMessages = event.entries
    .map((e) => {
      const line = `  ${e.message}`;
      return shouldRedact ? redactPII(line, redactionConfig) : line;
    })
    .join('\n');

  return `Given this failed event, identify the root cause in one sentence.

Event outcome: ${event.outcome}
Duration: ${event.duration}ms
Error logs:
${entrySummary || '  (no explicit error logs)'}

All log messages:
${allMessages}

Respond with a single sentence identifying the most likely root cause.`;
}

export function queryPrompt(question: string, contextSummary: string): string {
  return `You are answering a developer's question about their system logs.

Context (recent events):
${contextSummary}

Question: ${question}

Answer concisely. Reference specific events when relevant.
If the data doesn't contain enough information to answer, say so.`;
}
