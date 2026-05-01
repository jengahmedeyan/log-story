import type { LogEntry } from '../types/index.js';

export function groupById(
  entries: LogEntry[],
  fields: string[] = ['traceId', 'requestId', 'userId']
): { groups: Map<string, LogEntry[]>; ungrouped: LogEntry[] } {
  const groups = new Map<string, LogEntry[]>();
  const ungrouped: LogEntry[] = [];

  for (const entry of entries) {
    let grouped = false;

    for (const field of fields) {
      const value = entry[field as keyof LogEntry] as string | undefined;
      if (value) {
        const key = `${field}:${value}`;
        const group = groups.get(key);
        if (group) {
          group.push(entry);
        } else {
          groups.set(key, [entry]);
        }
        grouped = true;
        break; // Use first matching field (priority order)
      }
    }

    if (!grouped) {
      ungrouped.push(entry);
    }
  }

  return { groups, ungrouped };
}
