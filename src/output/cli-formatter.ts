import type { AnalysisResult, Insight, StoryUnit } from '../types/index.js';
import { SEVERITY_SYMBOLS, OUTCOME_SYMBOLS, INSIGHT_SYMBOLS } from './symbols.js';

/**
 * Format analysis results for CLI display — Story-based output.
 */
export function formatCLI(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║                      LOG STORY                               ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`  ${result.storyUnits.length} stories reconstructed from ${result.stats.totalEntries} log entries`);
  lines.push('');

  for (let i = 0; i < result.storyUnits.length; i++) {
    lines.push(formatStoryUnit(result.storyUnits[i], i + 1));
    lines.push('');
  }

  if (result.insights.length > 0) {
    lines.push('┌──────────────────────────────────────────────────────────────┐');
    lines.push('│  SYSTEM INSIGHTS                                             │');
    lines.push('└──────────────────────────────────────────────────────────────┘');
    lines.push('');
    for (const insight of result.insights) {
      lines.push(formatInsight(insight));
    }
    lines.push('');
  }

  lines.push('─'.repeat(64));
  lines.push('');
  lines.push(`  Summary: ${result.systemSummary}`);
  lines.push('');
  lines.push(`  Time: ${result.stats.processingTimeMs}ms  │  AI Cost: $${result.stats.estimatedCost.toFixed(4)} (${result.stats.aiCallsMade} calls)  │  Stories: ${result.stats.storiesGenerated}`);
  lines.push('');

  return lines.join('\n');
}

function formatStoryUnit(story: StoryUnit, index: number): string {
  const symbol = SEVERITY_SYMBOLS[story.severity] ?? '[i]';
  const outcomeSymbol = OUTCOME_SYMBOLS[story.outcome] ?? '[?]';
  const duration = formatDuration(story.duration);
  const timeStart = story.startTime.toLocaleTimeString();
  const timeEnd = story.endTime.toLocaleTimeString();

  const lines: string[] = [];

  const headerSuffix = story.duration > 0 ? ` [${timeStart} → ${timeEnd}] ${duration}` : ` [${timeStart}]`;
  lines.push(`  ${symbol} STORY ${index}: ${story.title}${headerSuffix} ${outcomeSymbol}`);
  lines.push(`  ${'─'.repeat(60)}`);

  lines.push(`  ${story.narrative}`);

  // Root cause (for failures)
  if (story.rootCause) {
    lines.push('');
    lines.push(`  Root Cause: ${story.rootCause}`);
  }

  if (story.impact) {
    lines.push(`  Impact: ${story.impact}`);
  }

  if (story.recommendation) {
    lines.push(`  Recommendation: ${story.recommendation}`);
  }

  if (story.actors.length > 0 || story.services.length > 0) {
    const meta: string[] = [];
    if (story.actors.length > 0) meta.push(`Users: ${story.actors.join(', ')}`);
    if (story.services.length > 0) meta.push(`Services: ${story.services.join(', ')}`);
    lines.push(`  ${meta.join('  │  ')}`);
  }

  return lines.join('\n');
}

function formatInsight(insight: Insight): string {
  const symbol = INSIGHT_SYMBOLS[insight.severity] ?? '[ ]';
  const lines: string[] = [];
  lines.push(`  ${symbol} ${insight.title}`);
  lines.push(`     ${insight.description}`);
  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms === 0) return '< 1ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
