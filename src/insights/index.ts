import type { StoryUnit, Insight, Severity, LogEvent } from '../types/index.js';

/**
 * Analyze story units and produce system-level insights:
 * - Recurring patterns
 * - Anomalies
 * - Cross-story correlations
 */
export function generateInsights(stories: StoryUnit[]): Insight[] {
  const insights: Insight[] = [];

  insights.push(...detectFailurePatterns(stories));
  insights.push(...detectRetryPatterns(stories));
  insights.push(...detectServiceIssues(stories));
  insights.push(...detectUserImpact(stories));

  return insights;
}

/**
 * Generate a system-level summary across all stories.
 */
export function generateSystemSummary(stories: StoryUnit[], insights: Insight[]): string {
  const total = stories.length;
  const failures = stories.filter((s) => s.outcome === 'failure').length;
  const critical = stories.filter((s) => s.severity === 'critical').length;
  const successes = stories.filter((s) => s.outcome === 'success').length;

  const parts: string[] = [];

  if (total === 0) return 'No activity detected in the provided logs.';

  parts.push(`${total} distinct operations detected.`);

  if (failures > 0) {
    parts.push(`${failures} failure(s)${critical > 0 ? ` (${critical} critical)` : ''}, ${successes} successful.`);
  } else {
    parts.push(`All operations completed successfully.`);
  }

  // Add top insight if available
  const criticalInsight = insights.find((i) => i.severity === 'critical' || i.severity === 'high');
  if (criticalInsight) {
    parts.push(criticalInsight.description);
  }

  return parts.join(' ');
}

function detectFailurePatterns(stories: StoryUnit[]): Insight[] {
  const insights: Insight[] = [];
  const failures = stories.filter((s) => s.outcome === 'failure');

  if (failures.length === 0) return [];

  // Group failures by similar root causes
  const causeGroups = new Map<string, StoryUnit[]>();
  for (const failure of failures) {
    const cause = normalizeCause(failure.rootCause ?? 'unknown');
    const group = causeGroups.get(cause) ?? [];
    group.push(failure);
    causeGroups.set(cause, group);
  }

  for (const [cause, group] of causeGroups) {
    if (group.length >= 1) {
      const timeRange = {
        start: group[0].startTime,
        end: group[group.length - 1].endTime,
      };

      insights.push({
        type: 'pattern',
        title: `Recurring failure: ${cause}`,
        description: `${cause} occurred ${group.length} time(s) within the analyzed window. This suggests a systemic issue rather than a transient error.`,
        occurrences: group.length,
        timeRange,
        relatedEvents: group.flatMap((g) => g.events.map((e) => e.id)),
        severity: group.length >= 3 ? 'critical' : group.length >= 2 ? 'high' : 'medium',
      });
    }
  }

  return insights;
}

function detectRetryPatterns(stories: StoryUnit[]): Insight[] {
  const insights: Insight[] = [];

  const storiesWithRetries = stories.filter((s) =>
    s.events.some((e) => e.actions.some((a) => a.status === 'retried'))
  );

  if (storiesWithRetries.length === 0) return [];

  const failedRetries = storiesWithRetries.filter((s) => s.outcome === 'failure');

  if (failedRetries.length > 0) {
    insights.push({
      type: 'anomaly',
      title: 'Retry logic not resolving failures',
      description: `Retry attempts failed to recover in ${failedRetries.length} case(s). The retry mechanism is not effective against the current failure mode.`,
      occurrences: failedRetries.length,
      timeRange: {
        start: failedRetries[0].startTime,
        end: failedRetries[failedRetries.length - 1].endTime,
      },
      relatedEvents: failedRetries.flatMap((s) => s.events.map((e) => e.id)),
      severity: 'high',
    });
  }

  return insights;
}

function detectServiceIssues(stories: StoryUnit[]): Insight[] {
  const insights: Insight[] = [];

  // Count failures per service/dependency
  const serviceFailures = new Map<string, number>();
  for (const story of stories) {
    if (story.outcome === 'failure') {
      for (const service of story.services) {
        serviceFailures.set(service, (serviceFailures.get(service) ?? 0) + 1);
      }
    }
  }

  for (const [service, count] of serviceFailures) {
    if (count >= 1) {
      insights.push({
        type: 'trend',
        title: `Service degradation: ${service}`,
        description: `${service} was involved in ${count} failed operation(s). Consider checking its health and response times.`,
        occurrences: count,
        timeRange: {
          start: stories[0].startTime,
          end: stories[stories.length - 1].endTime,
        },
        relatedEvents: [],
        severity: count >= 3 ? 'critical' : count >= 2 ? 'high' : 'medium',
      });
    }
  }

  return insights;
}

function detectUserImpact(stories: StoryUnit[]): Insight[] {
  const insights: Insight[] = [];

  const escalations = stories.filter((s) =>
    s.events.some((e) =>
      e.entries.some((en) => /ticket|support|escalat/i.test(en.message))
    )
  );

  if (escalations.length > 0) {
    insights.push({
      type: 'trend',
      title: 'Customer escalations triggered',
      description: `${escalations.length} failure(s) resulted in support ticket creation. Failed operations are directly impacting customer experience.`,
      occurrences: escalations.length,
      timeRange: {
        start: escalations[0].startTime,
        end: escalations[escalations.length - 1].endTime,
      },
      relatedEvents: escalations.flatMap((s) => s.events.map((e) => e.id)),
      severity: 'high',
    });
  }

  return insights;
}

function normalizeCause(cause: string): string {
  const lower = cause.toLowerCase();
  if (lower.includes('timeout')) return 'Payment provider timeout';
  if (lower.includes('connection pool')) return 'Connection pool exhaustion';
  if (lower.includes('memory')) return 'Memory pressure';
  if (lower.includes('auth') || lower.includes('denied')) return 'Authentication failure';
  return cause.slice(0, 50);
}
