import type { LogEntry } from '../types/index.js';

export function groupByTime(
  entries: LogEntry[],
  windowMs: number = 5000
): Map<string, LogEntry[]> {
  if (entries.length === 0) return new Map();

  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  const groups = new Map<string, LogEntry[]>();
  let currentGroup: LogEntry[] = [sorted[0]];
  let groupIndex = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.timestamp.getTime() - prev.timestamp.getTime();

    if (gap <= windowMs) {
      currentGroup.push(curr);
    } else {
      groups.set(`time:${groupIndex}`, currentGroup);
      groupIndex++;
      currentGroup = [curr];
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    groups.set(`time:${groupIndex}`, currentGroup);
  }

  return groups;
}
