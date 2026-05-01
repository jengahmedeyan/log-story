import type { LogEntry, LogEvent } from '../types/index.js';
import { buildEvent } from './event-builder.js';

export function extractEvents(groups: Map<string, LogEntry[]>): LogEvent[] {
  const events: LogEvent[] = [];

  for (const [groupKey, entries] of groups) {
    if (entries.length === 0) continue;
    events.push(buildEvent(groupKey, entries));
  }

  // Sort events by start time
  events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  return events;
}

export { buildEvent } from './event-builder.js';
