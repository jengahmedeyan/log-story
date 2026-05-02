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

    // Break group if time gap exceeds window
    // Also break if component changes AND there's a meaningful gap (> 2s)
    const prevComponent = getComponent(prev);
    const currComponent = getComponent(curr);
    const componentChanged = prevComponent && currComponent && prevComponent !== currComponent;
    // Also break if log format changes (different subsystems)
    const formatChanged = prev.format && curr.format && prev.format !== curr.format;
    const shouldBreak = gap > windowMs || (componentChanged && gap > 2000) || (formatChanged && gap > 0);

    if (!shouldBreak) {
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

function getComponent(entry: LogEntry): string | undefined {
  return entry.source
    ?? (entry.metadata?.component as string | undefined)
    ?? (entry.metadata?.service as string | undefined);
}
