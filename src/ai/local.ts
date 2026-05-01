import type { AIProvider, LogEvent, StoryUnit } from '../types/index.js';

/**
 * Local/offline AI provider that uses heuristic templates to generate
 * narratives without external API calls. Zero cost, zero latency.
 */
export function create(): AIProvider {
  return {
    async generateNarrative(event: LogEvent): Promise<string> {
      const actions = event.actions;
      const duration = formatDuration(event.duration);
      const entryCount = event.entries.length;

      if (event.outcome === 'failure') {
        const errorEntries = event.entries.filter((e) => e.level === 'error' || e.level === 'fatal');
        const errorMsg = errorEntries[0]?.message ?? 'Unknown error';
        const target = actions.find((a) => a.status === 'failed')?.target ?? 'the service';
        return `A request to ${target} failed after ${duration} (${entryCount} log entries). Error: ${errorMsg}`;
      }

      if (event.outcome === 'partial') {
        const failed = actions.filter((a) => a.status === 'failed').length;
        const total = actions.length;
        return `Operation partially completed (${total - failed}/${total} actions succeeded) over ${duration}.`;
      }

      // Success or unknown
      if (actions.length > 0) {
        const actionSummary = actions
          .slice(0, 3)
          .map((a) => `${a.type}${a.target ? ` → ${a.target}` : ''}`)
          .join(', ');
        return `Completed ${actionSummary} in ${duration}.`;
      }

      // Generic
      const messages = event.entries.slice(0, 3).map((e) => e.message);
      return `Processed ${entryCount} log entries over ${duration}: ${messages.join(' → ')}`;
    },

    async generateRootCause(event: LogEvent): Promise<string> {
      const errorEntries = event.entries.filter((e) => e.level === 'error' || e.level === 'fatal');
      if (errorEntries.length === 0) return 'No errors detected in the event.';

      const errors = errorEntries.map((e) => e.message);

      // Look for common patterns
      const hasTimeout = errors.some((m) => /timeout|timed out/i.test(m));
      const hasConnection = errors.some((m) => /connect|ECONNREFUSED|ENOTFOUND/i.test(m));
      const hasAuth = errors.some((m) => /auth|unauthorized|forbidden|401|403/i.test(m));
      const has5xx = errors.some((m) => /5\d{2}|internal server/i.test(m));

      if (hasTimeout) return `Timeout detected: ${errors[0]}. The downstream service may be overloaded or unresponsive.`;
      if (hasConnection) return `Connection failure: ${errors[0]}. The target service may be down or unreachable.`;
      if (hasAuth) return `Authentication/authorization failure: ${errors[0]}. Check credentials or permissions.`;
      if (has5xx) return `Server error from downstream: ${errors[0]}. The dependent service is experiencing issues.`;

      return `Error detected: ${errors[0]}`;
    },

    async answerQuery(query: string, context: StoryUnit[]): Promise<string> {
      const failures = context.filter((s) => s.outcome === 'failure');
      const q = query.toLowerCase();

      if (q.includes('fail') || q.includes('error') || q.includes('wrong')) {
        if (failures.length === 0) return 'No failures detected in the provided logs.';
        const summary = failures
          .slice(0, 5)
          .map((s) => `- ${s.narrative}`)
          .join('\n');
        return `Found ${failures.length} failure(s):\n${summary}`;
      }

      if (q.includes('slow') || q.includes('latency') || q.includes('performance')) {
        const sorted = [...context].sort((a, b) => b.duration - a.duration);
        const slowest = sorted.slice(0, 3);
        const summary = slowest
          .map((s) => `- ${formatDuration(s.duration)}: ${s.narrative}`)
          .join('\n');
        return `Slowest operations:\n${summary}`;
      }

      // Generic answer
      return `Analyzed ${context.length} events. ${failures.length} failures detected. Use a cloud AI provider for more detailed answers.`;
    },

    estimateCost(): number {
      return 0; // Local provider is free
    },
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
