import type { AnalysisResult } from '../types/index.js';

export function formatJSON(result: AnalysisResult): string {
  return JSON.stringify(
    {
      stories: result.storyUnits.map((s) => ({
        id: s.id,
        title: s.title,
        severity: s.severity,
        outcome: s.outcome,
        timeRange: {
          start: s.startTime.toISOString(),
          end: s.endTime.toISOString(),
        },
        duration: s.duration,
        narrative: s.narrative,
        rootCause: s.rootCause,
        impact: s.impact,
        recommendation: s.recommendation,
        actors: s.actors,
        services: s.services,
      })),
      insights: result.insights.map((i) => ({
        type: i.type,
        severity: i.severity,
        title: i.title,
        description: i.description,
        occurrences: i.occurrences,
      })),
      summary: result.systemSummary,
      stats: result.stats,
    },
    null,
    2
  );
}
