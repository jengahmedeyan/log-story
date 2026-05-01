import chalk from 'chalk';
import type { AnalysisResult, Insight, StoryUnit } from '../types/index.js';
import { INSIGHT_SYMBOLS } from './symbols.js';

const OUTCOME_ICONS: Record<string, string> = {
  success: chalk.green('✓'),
  failure: chalk.red('✗'),
  partial: chalk.yellow('!'),
  unknown: chalk.gray('?'),
};

const SEVERITY_DOTS: Record<string, string> = {
  info: chalk.blue('●'),
  warning: chalk.yellow('●'),
  critical: chalk.red('●'),
};

/**
 * Format analysis results for CLI display — Story-based output.
 */
export function formatCLI(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold.white(`  LOG STORY ANALYSIS`));
  lines.push(chalk.gray(`  ${result.storyUnits.length} stories from ${result.stats.totalEntries} log entries`));
  lines.push('');
  lines.push(chalk.gray('  ' + '─'.repeat(60)));
  lines.push('');

  for (let i = 0; i < result.storyUnits.length; i++) {
    lines.push(formatStoryUnit(result.storyUnits[i], i + 1));
    if (i < result.storyUnits.length - 1) {
      lines.push('');
    }
  }

  if (result.insights.length > 0) {
    lines.push('');
    lines.push(chalk.gray('  ' + '─'.repeat(60)));
    lines.push('');
    lines.push(chalk.bold.white('  INSIGHTS'));
    lines.push('');
    for (const insight of result.insights) {
      lines.push(formatInsight(insight));
    }
  }

  lines.push('');
  lines.push(chalk.gray('  ' + '─'.repeat(60)));
  lines.push('');
  lines.push(`  ${chalk.bold('Summary:')} ${result.systemSummary}`);
  lines.push('');
  lines.push(`  ${chalk.gray('Time:')} ${result.stats.processingTimeMs}ms  ${chalk.gray('│')}  ${chalk.gray('AI:')} $${result.stats.estimatedCost.toFixed(4)} (${result.stats.aiCallsMade} calls)  ${chalk.gray('│')}  ${chalk.gray('Stories:')} ${result.stats.storiesGenerated}`);
  lines.push('');

  return lines.join('\n');
}

function formatStoryUnit(story: StoryUnit, index: number): string {
  const dot = SEVERITY_DOTS[story.severity] ?? chalk.gray('●');
  const outcomeIcon = OUTCOME_ICONS[story.outcome] ?? '?';
  const duration = formatDuration(story.duration);
  const timeStart = story.startTime.toLocaleTimeString('en-US', { hour12: false });
  const timeEnd = story.endTime.toLocaleTimeString('en-US', { hour12: false });

  const lines: string[] = [];

  // Header: ● STORY 1  Title
  //    10:00:01 → 10:01:10  (69.8s)  [✓]
  lines.push(`  ${dot} ${chalk.bold(`STORY ${index}`)}  ${story.title}`);
  lines.push(`     ${chalk.gray(`${timeStart} → ${timeEnd}`)}  ${chalk.gray(`(${duration})`)}  [${outcomeIcon}]`);
  lines.push('');

  // Narrative (indented, wrapped)
  const wrappedNarrative = wrapText(story.narrative, 55);
  for (const line of wrappedNarrative) {
    lines.push(`     ${line}`);
  }

  // Root cause, impact, recommendation (for failures/partial)
  if (story.rootCause) {
    lines.push(`     ${chalk.red('Root Cause:')} ${story.rootCause}`);
  }
  if (story.impact) {
    lines.push(`     ${chalk.yellow('Impact:')} ${story.impact}`);
  }
  if (story.recommendation) {
    lines.push(`     ${chalk.green('Recommendation:')} ${story.recommendation}`);
  }

  // Actors & services (compact)
  if (story.actors.length > 0 || story.services.length > 0) {
    const meta: string[] = [];
    if (story.actors.length > 0) meta.push(`Users: ${story.actors.join(', ')}`);
    if (story.services.length > 0) meta.push(`Services: ${story.services.join(', ')}`);
    lines.push(`     ${chalk.gray(meta.join('  │  '))}`);
  }

  return lines.join('\n');
}

function formatInsight(insight: Insight): string {
  const symbol = INSIGHT_SYMBOLS[insight.severity] ?? '[ ]';
  return `  ${symbol} ${insight.title}\n     ${chalk.gray(insight.description)}`;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '< 1ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);

  return lines;
}
