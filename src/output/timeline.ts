import type { StoryUnit } from '../types/index.js';
import { OUTCOME_SYMBOLS } from './symbols.js';

export function formatTimeline(stories: StoryUnit[]): string {
  const lines: string[] = [];

  for (const story of stories) {
    const entries = story.events.flatMap((e) => e.entries);
    const symbol = OUTCOME_SYMBOLS[story.outcome] ?? '[?]';

    if (entries.length === 1) {
      // Single entry event
      const time = entries[0].timestamp.toLocaleTimeString();
      lines.push(`${time} ── ${symbol} ${entries[0].message}`);
    } else {
      // Multi-entry event
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const time = entry.timestamp.toLocaleTimeString();
        const prefix =
          i === 0 ? '┬─' : i === entries.length - 1 ? '└─' : '├─';
        const marker = i === entries.length - 1 ? ` ${symbol}` : '';
        lines.push(`${time} ${prefix} ${entry.message}${marker}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
