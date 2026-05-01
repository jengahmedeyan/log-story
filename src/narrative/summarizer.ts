import type { LogEvent } from '../types/index.js';

/**
 * Template-based summarizer that works WITHOUT AI.
 * Handles simple events locally, returns null for complex events that need AI.
 */
export function templateSummarize(event: LogEvent): { narrative: string; rootCause?: string } | null {
  // Simple events (≤ 5 entries, clear outcome) can be summarized without AI
  if (event.entries.length > 8 && event.actions.length > 3) {
    return null; // Too complex, needs AI
  }

  const narrative = buildTemplateNarrative(event);
  if (!narrative) return null;

  return {
    narrative,
    rootCause: event.outcome === 'failure' ? buildRootCause(event) : undefined,
  };
}

function buildTemplateNarrative(event: LogEvent): string | null {
  const actions = event.actions;
  const duration = formatDuration(event.duration);

  if (actions.length === 0) {
    // No actions detected, build from messages
    return buildFromMessages(event);
  }

  const parts: string[] = [];

  // Describe what happened
  const primaryAction = actions[0];
  const retries = actions.filter((a) => a.status === 'retried').length;

  if (primaryAction.type === 'api_call') {
    const target = primaryAction.target ?? 'an external service';
    if (event.outcome === 'failure') {
      if (retries > 0) {
        parts.push(
          `The system attempted to call ${target} ${retries + 1} time(s), but all attempts failed`
        );
      } else {
        parts.push(`A call to ${target} failed`);
      }
      // Add reason if we can detect it
      const timeoutAction = actions.find((a) => a.error?.includes('timeout'));
      if (timeoutAction || event.entries.some((e) => /timeout/i.test(e.message))) {
        parts.push(`due to a timeout after ${duration}`);
      }
    } else if (event.outcome === 'success') {
      parts.push(`Successfully called ${target} (${duration})`);
    }
  } else if (primaryAction.type === 'authentication') {
    if (event.outcome === 'success') {
      parts.push(`User authentication completed successfully (${duration})`);
    } else {
      parts.push(`Authentication attempt failed`);
    }
  } else if (primaryAction.type === 'db_operation') {
    const target = primaryAction.target ?? 'the database';
    if (event.outcome === 'success') {
      parts.push(`Database operation on ${target} completed (${duration})`);
    } else {
      parts.push(`Database operation on ${target} failed`);
    }
  }

  if (parts.length === 0) return null;
  return parts.join(' ') + '.';
}

function buildFromMessages(event: LogEvent): string {
  const messages = event.entries.map((e) => e.message).join(' → ');
  const duration = formatDuration(event.duration);

  if (event.outcome === 'failure') {
    return `An operation failed after ${duration}. Sequence: ${messages}`;
  }
  if (event.outcome === 'success') {
    return `Operation completed successfully in ${duration}.`;
  }
  return `Activity detected (${duration}): ${messages}`;
}

function buildRootCause(event: LogEvent): string | undefined {
  const errorEntries = event.entries.filter(
    (e) => e.level === 'error' || e.level === 'fatal'
  );
  if (errorEntries.length > 0) {
    return errorEntries[0].message;
  }
  const failedActions = event.actions.filter((a) => a.status === 'failed');
  if (failedActions.length > 0 && failedActions[0].error) {
    return failedActions[0].error;
  }
  return undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
