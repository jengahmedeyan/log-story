import type { LogEvent } from '../types/index.js';

export function narrativePrompt(event: LogEvent): string {
  const actionsList = event.actions
    .map((a) => `- ${a.type}${a.target ? ` → ${a.target}` : ''} [${a.status}]${a.error ? ` (${a.error})` : ''}`)
    .join('\n');

  const entrySummary = event.entries
    .slice(0, 15) // Limit to keep prompt small
    .map((e) => `  [${e.level.toUpperCase()}] ${e.message}`)
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

export function rootCausePrompt(event: LogEvent): string {
  const entrySummary = event.entries
    .filter((e) => e.level === 'error' || e.level === 'warn' || e.level === 'fatal')
    .map((e) => `  [${e.level.toUpperCase()}] ${e.message}`)
    .join('\n');

  return `Given this failed event, identify the root cause in one sentence.

Event outcome: ${event.outcome}
Duration: ${event.duration}ms
Error logs:
${entrySummary || '  (no explicit error logs)'}

All log messages:
${event.entries.map((e) => `  ${e.message}`).join('\n')}

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
