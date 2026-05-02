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
  insights.push(...detectCrossStoryCorrelations(stories));

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
    const timeRange = {
      start: group[0].startTime,
      end: group[group.length - 1].endTime,
    };

    if (group.length >= 2) {
      insights.push({
        type: 'pattern',
        title: `Recurring failure: ${cause}`,
        description: `${cause} occurred ${group.length} time(s) within the analyzed window. This suggests a systemic issue rather than a transient error.`,
        occurrences: group.length,
        timeRange,
        relatedEvents: group.flatMap((g) => g.events.map((e) => e.id)),
        severity: group.length >= 3 ? 'critical' : 'high',
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
    if (count >= 2) {
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

/**
 * Detect temporal correlations between stories — the most valuable insight type.
 * Looks for patterns like: failure A at time T1 correlates with degradation B at T2.
 */
function detectCrossStoryCorrelations(stories: StoryUnit[]): Insight[] {
  const insights: Insight[] = [];
  const failures = stories.filter((s) => s.outcome === 'failure' || s.outcome === 'partial');

  if (failures.length === 0) return insights;

  // Look for failures that precede scaling events or performance degradation
  for (const failure of failures) {
    const failureTime = failure.endTime.getTime();
    const failureMessages = failure.events.flatMap((e) => e.entries.map((en) => en.message.toLowerCase())).join(' ');

    // Find stories that happen shortly after this failure (within 15 min) that could be effects
    const potentialEffects = stories.filter((s) => {
      if (s === failure) return false;
      const offset = s.startTime.getTime() - failureTime;
      return offset > 0 && offset <= 900_000; // 15 minutes
    });

    for (const effect of potentialEffects) {
      const effectMessages = effect.events.flatMap((e) => e.entries.map((en) => en.message.toLowerCase())).join(' ');

      // Connection pool exhaustion → scaling or performance reports
      if (/connection.?pool|pool.?exhaust/.test(failureMessages) && /metrics|p\d{2}|latency|scal/.test(effectMessages)) {
        insights.push({
          type: 'correlation',
          title: 'Resource exhaustion preceded performance impact',
          description: `${failure.title} at ${formatTime(failure.startTime)} correlates with ${effect.title} at ${formatTime(effect.startTime)}. The pool exhaustion likely caused downstream latency increases.`,
          occurrences: 2,
          timeRange: { start: failure.startTime, end: effect.endTime },
          relatedEvents: [...failure.events.map((e) => e.id), ...effect.events.map((e) => e.id)],
          severity: 'high',
        });
        break; // One correlation per failure is enough
      }

      // Failure → autoscale reaction
      if (failure.outcome === 'failure' && /scal(?:ing|e)|autoscale|instance/.test(effectMessages)) {
        insights.push({
          type: 'correlation',
          title: 'Failure triggered scaling response',
          description: `${failure.title} at ${formatTime(failure.startTime)} was followed by ${effect.title} at ${formatTime(effect.startTime)}, suggesting the system auto-remediated.`,
          occurrences: 2,
          timeRange: { start: failure.startTime, end: effect.endTime },
          relatedEvents: [...failure.events.map((e) => e.id), ...effect.events.map((e) => e.id)],
          severity: 'medium',
        });
        break;
      }
    }
  }

  // Detect cascading failure patterns: multiple failures within a short window
  // Only emit one consolidated insight instead of per-window duplicates
  const failureWindows = groupByTimeWindow(failures, 300_000); // 5-minute windows
  const cascadingWindows = failureWindows.filter((w) => w.length >= 2);
  if (cascadingWindows.length > 0) {
    const totalFailures = cascadingWindows.reduce((sum, w) => sum + w.length, 0);
    const firstWindow = cascadingWindows[0];
    const lastWindow = cascadingWindows[cascadingWindows.length - 1];
    // Show up to 5 distinct titles to avoid wall-of-text
    const allTitles = cascadingWindows.flatMap((w) => w.map((s) => s.title));
    const uniqueTitles = [...new Set(allTitles)].slice(0, 5);
    const titleSummary = uniqueTitles.join(', ') + (allTitles.length > 5 ? ` (+${allTitles.length - 5} more)` : '');

    insights.push({
      type: 'correlation',
      title: 'Cascading failures detected',
      description: `${totalFailures} failures across ${cascadingWindows.length} burst(s) within 5-minute windows (${titleSummary}). These may share a common upstream cause.`,
      occurrences: totalFailures,
      timeRange: { start: firstWindow[0].startTime, end: lastWindow[lastWindow.length - 1].endTime },
      relatedEvents: cascadingWindows.flatMap((w) => w.flatMap((s) => s.events.map((e) => e.id))),
      severity: 'high',
    });
  }

  return insights;
}

function formatTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function groupByTimeWindow(stories: StoryUnit[], windowMs: number): StoryUnit[][] {
  if (stories.length === 0) return [];

  const sorted = [...stories].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const windows: StoryUnit[][] = [];
  let currentWindow: StoryUnit[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].startTime.getTime() - currentWindow[0].startTime.getTime();
    if (gap <= windowMs) {
      currentWindow.push(sorted[i]);
    } else {
      windows.push(currentWindow);
      currentWindow = [sorted[i]];
    }
  }
  windows.push(currentWindow);

  return windows;
}
