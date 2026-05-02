import type { LogEntry } from '../types/index.js';

/**
 * Alias map: Node.js logging library field names for correlation IDs.
 * Locked to what pino, winston, bunyan, and express/morgan actually produce.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  requestId: ['req_id', 'request_id', 'correlation_id', 'x-request-id', 'correlationId'],
  traceId: ['trace_id', 'spanId'],
  userId: ['user_id', 'uid', 'actor', 'sub', 'account_id'],
  sessionId: ['session_id', 'sessId'],
  jobId: ['job_id', 'jid', 'task_id'],
};

/**
 * Get the value for a grouping field from an entry, checking the entry property
 * and then metadata aliases.
 */
function getFieldValue(entry: LogEntry, field: string): string | undefined {
  // Check the direct entry property first
  const directValue = entry[field as keyof LogEntry] as string | undefined;
  if (directValue) return directValue;

  // Check metadata aliases
  const aliases = FIELD_ALIASES[field];
  if (aliases && entry.metadata) {
    for (const alias of aliases) {
      const val = entry.metadata[alias];
      if (val !== undefined && val !== null && val !== '') return String(val);
    }
  }

  return undefined;
}

export function groupById(
  entries: LogEntry[],
  fields: string[] = ['traceId', 'requestId', 'jobId', 'userId']
): { groups: Map<string, LogEntry[]>; ungrouped: LogEntry[] } {
  const rawGroups = new Map<string, LogEntry[]>();
  const ungrouped: LogEntry[] = [];

  for (const entry of entries) {
    let grouped = false;

    for (const field of fields) {
      const value = getFieldValue(entry, field);
      if (value) {
        const key = `${field}:${value}`;
        const group = rawGroups.get(key);
        if (group) {
          group.push(entry);
        } else {
          rawGroups.set(key, [entry]);
        }
        grouped = true;
        break; // Use first matching field (priority order)
      }
    }

    if (!grouped) {
      ungrouped.push(entry);
    }
  }

  // Merge pass: merge groups whose key values are identical but field names differ
  // e.g., traceId:abc and requestId:abc → merge into the higher-priority field group
  mergeIdenticalValueGroups(rawGroups, fields);

  // Split groups that have large time gaps into sub-groups
  // Use a longer threshold for job groups (retries can be minutes apart)
  const groups = new Map<string, LogEntry[]>();
  for (const [key, groupEntries] of rawGroups) {
    const isJobGroup = key.startsWith('jobId:');
    const gapThreshold = isJobGroup ? 900_000 : 300_000; // 15 min for jobs, 5 min otherwise
    const subGroups = splitByTimeGap(groupEntries, gapThreshold);
    if (subGroups.length === 1) {
      groups.set(key, subGroups[0]);
    } else {
      for (let i = 0; i < subGroups.length; i++) {
        groups.set(`${key}:${i}`, subGroups[i]);
      }
    }
  }

  return { groups, ungrouped };
}

/**
 * Merge groups that have identical values but different field names.
 * E.g., traceId:abc and requestId:abc → merge into the higher-priority field.
 */
function mergeIdenticalValueGroups(groups: Map<string, LogEntry[]>, fields: string[]): void {
  // Build a map of value → list of group keys
  const valueToKeys = new Map<string, string[]>();
  for (const key of groups.keys()) {
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1) continue;
    const value = key.substring(colonIdx + 1);
    const existing = valueToKeys.get(value);
    if (existing) {
      existing.push(key);
    } else {
      valueToKeys.set(value, [key]);
    }
  }

  for (const [, keys] of valueToKeys) {
    if (keys.length <= 1) continue;

    // Find the highest-priority field among these keys
    let bestKey = keys[0];
    let bestPriority = fields.length;
    for (const key of keys) {
      const field = key.substring(0, key.indexOf(':'));
      const priority = fields.indexOf(field);
      if (priority !== -1 && priority < bestPriority) {
        bestPriority = priority;
        bestKey = key;
      }
    }

    // Merge all other groups into the best one
    const bestEntries = groups.get(bestKey)!;
    for (const key of keys) {
      if (key === bestKey) continue;
      const entries = groups.get(key);
      if (entries) {
        bestEntries.push(...entries);
        groups.delete(key);
      }
    }
  }
}

/**
 * Split a group of entries into sub-groups whenever there's a time gap
 * exceeding the threshold.
 */
function splitByTimeGap(entries: LogEntry[], gapThreshold: number): LogEntry[][] {
  if (entries.length <= 1) return [entries];

  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  const subGroups: LogEntry[][] = [];
  let current: LogEntry[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime();
    if (gap > gapThreshold) {
      subGroups.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  subGroups.push(current);

  return subGroups;
}
