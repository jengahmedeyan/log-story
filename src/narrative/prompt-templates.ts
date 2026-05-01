import type { LogEvent, RedactionConfig } from '../types/index.js';
import { redactPII } from '../parser/redaction.js';

/**
 * Sanitize text before embedding in AI prompts.
 * Strips control characters, null bytes, and known prompt injection patterns.
 */
function sanitizeForPrompt(text: string): string {
  return text
    // Remove null bytes and non-printable control chars (keep newlines/tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Neutralize common prompt injection patterns
    .replace(/ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, '[filtered]')
    .replace(/you\s+are\s+now\s+(a|an)\s+/gi, '[filtered]')
    .replace(/system\s*:\s*/gi, '[filtered]')
    .replace(/\[INST\]/gi, '[filtered]')
    .replace(/<\|im_start\|>/gi, '[filtered]')
    .replace(/<\|im_end\|>/gi, '[filtered]');
}

export function narrativePrompt(event: LogEvent, redactionConfig?: RedactionConfig): string {
  const shouldRedact = redactionConfig?.enabled ?? false;

  const actionsList = event.actions
    .map((a) => {
      const targetStr = a.target ? ` → ${a.target}` : '';
      const errorStr = a.error ? ` (${a.error})` : '';
      let line = `- ${a.type}${targetStr} [${a.status}]${errorStr}`;
      line = sanitizeForPrompt(line);
      return shouldRedact ? redactPII(line, redactionConfig) : line;
    })
    .join('\n');

  const entrySummary = event.entries
    .slice(0, 15) // Limit to keep prompt small
    .map((e) => {
      let line = `  [${e.level.toUpperCase()}] ${e.message}`;
      line = sanitizeForPrompt(line);
      return shouldRedact ? redactPII(line, redactionConfig) : line;
    })
    .join('\n');

  return `You are a system behavior analyst writing concise incident narratives. Given the following structured event data, write a 1-3 sentence explanation of what happened.

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
- Use active voice and vary sentence structure
- NEVER repeat the same fact or sentence
- Do not speculate beyond the data
- Write in clear narrative prose, not a list
- If multiple attempts occurred, state the count once (e.g., "failed 3 times") rather than describing each attempt`;
}

export function rootCausePrompt(event: LogEvent, redactionConfig?: RedactionConfig): string {
  const shouldRedact = redactionConfig?.enabled ?? false;

  const entrySummary = event.entries
    .filter((e) => e.level === 'error' || e.level === 'warn' || e.level === 'fatal')
    .map((e) => {
      let line = `  [${e.level.toUpperCase()}] ${e.message}`;
      line = sanitizeForPrompt(line);
      return shouldRedact ? redactPII(line, redactionConfig) : line;
    })
    .join('\n');

  const allMessages = event.entries
    .map((e) => {
      let line = `  ${e.message}`;
      line = sanitizeForPrompt(line);
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
${sanitizeForPrompt(contextSummary)}

Question: ${sanitizeForPrompt(question)}

Answer concisely. Reference specific events when relevant.
If the data doesn't contain enough information to answer, say so.`;
}
