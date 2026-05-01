import type { LogEntry, GroupingConfig } from '../types/index.js';
import { groupById } from './id-grouper.js';
import { groupByTime } from './time-grouper.js';
import { groupByInference } from './inference-grouper.js';

export interface GroupResult {
  groups: Map<string, LogEntry[]>;
  stats: {
    totalGroups: number;
    byId: number;
    byTime: number;
    byInference: number;
  };
}

/**
 * Multi-strategy grouping: first by ID, then absorb nearby entries, then time-group the rest.
 */
export function groupEntries(entries: LogEntry[], config?: GroupingConfig): GroupResult {
  const fields = config?.fields ?? ['sessionId', 'traceId', 'requestId', 'userId'];
  const timeWindow = config?.timeWindow ?? 5000;

  const { groups: idGroups, ungrouped } = groupById(entries, fields);

  // Try to absorb ungrouped entries into nearby ID groups
  // (entries sharing userId + within time window of an existing group)
  const stillUngrouped = absorbIntoGroups(ungrouped, idGroups, timeWindow);

  // Group by content similarity (keyword-based)
  const inferenceGroups = groupByInference(stillUngrouped);

  // Collect entries that didn't form multi-entry inference clusters
  const afterInference: LogEntry[] = [];
  for (const [key, entries] of inferenceGroups) {
    if (key.includes('-single-')) {
      afterInference.push(...entries);
      inferenceGroups.delete(key);
    }
  }

  const timeGroups = groupByTime(afterInference, timeWindow);

  // Merge all groups
  const allGroups = new Map<string, LogEntry[]>([...idGroups, ...inferenceGroups, ...timeGroups]);

  return {
    groups: allGroups,
    stats: {
      totalGroups: allGroups.size,
      byId: idGroups.size,
      byTime: timeGroups.size,
      byInference: inferenceGroups.size,
    },
  };
}

function absorbIntoGroups(
  ungrouped: LogEntry[],
  idGroups: Map<string, LogEntry[]>,
  timeWindow: number
): LogEntry[] {
  const stillUngrouped: LogEntry[] = [];
  // Use a wider window for absorption (6x the base time window)
  const absorptionWindow = Math.max(timeWindow * 6, 60_000);

  // Pre-compute group time bounds to avoid O(n*m*k) recalculation
  const groupBounds = new Map<string, { start: number; end: number; entries: LogEntry[] }>();
  for (const [key, groupEntries] of idGroups) {
    let start = Infinity;
    let end = -Infinity;
    for (const e of groupEntries) {
      const t = e.timestamp.getTime();
      if (t < start) start = t;
      if (t > end) end = t;
    }
    groupBounds.set(key, { start, end, entries: groupEntries });
  }

  for (const entry of ungrouped) {
    let absorbed = false;
    const entryTime = entry.timestamp.getTime();
    const entryUserId = entry.userId ?? extractUserIdFromMetadata(entry);

    // Find the best matching group
    let bestGroup: LogEntry[] | null = null;
    let bestScore = 0;

    for (const [, { start: groupStart, end: groupEnd, entries: groupEntries }] of groupBounds) {

      // Entry must be within the time range of this group (± absorption window)
      if (entryTime < groupStart - absorptionWindow || entryTime > groupEnd + absorptionWindow) continue;

      let score = 0;

      // Score by userId match
      const groupUserId = groupEntries.find((e) => e.userId)?.userId
        ?? groupEntries.map((e) => extractUserIdFromMetadata(e)).find(Boolean);

      if (entryUserId && groupUserId && entryUserId === groupUserId) {
        score += 10;
      }

      // Score by sessionId match
      const entrySessionId = entry.sessionId;
      const groupSessionId = groupEntries.find((e) => e.sessionId)?.sessionId;
      if (entrySessionId && groupSessionId && entrySessionId === groupSessionId) {
        score += 10;
      }

      // Score by being inside the group's time span (strongly suggests same flow)
      if (entryTime >= groupStart && entryTime <= groupEnd) {
        score += 5;
      }

      // Score by being within the base time window of the group boundary
      // (adjacent events that just barely missed the group)
      const distToGroup = Math.min(
        Math.abs(entryTime - groupStart),
        Math.abs(entryTime - groupEnd)
      );
      if (distToGroup <= timeWindow) {
        score += 5;
      } else {
        // Score by looser time proximity (within 10s of any group entry)
        const withinTight = groupEntries.some(
          (e) => Math.abs(entryTime - e.timestamp.getTime()) <= 10_000
        );
        if (withinTight) score += 3;
      }

      // Score by shared service references in metadata
      const entryService = entry.metadata?.service as string | undefined;
      const groupServices = new Set(groupEntries.map((e) => e.metadata?.service as string).filter(Boolean));
      if (entryService && groupServices.has(entryService)) {
        score += 2;
      }

      if (score > bestScore) {
        bestScore = score;
        bestGroup = groupEntries;
      }
    }

    // Absorb if score is high enough
    if (bestGroup && bestScore >= 5) {
      bestGroup.push(entry);
      // Update pre-computed bounds for the group that absorbed this entry
      for (const [key, bounds] of groupBounds) {
        if (bounds.entries === bestGroup) {
          if (entryTime < bounds.start) bounds.start = entryTime;
          if (entryTime > bounds.end) bounds.end = entryTime;
          break;
        }
      }
      absorbed = true;
    }

    if (!absorbed) {
      stillUngrouped.push(entry);
    }
  }

  return stillUngrouped;
}

function extractUserIdFromMetadata(entry: LogEntry): string | undefined {
  // Check metadata for nested user ID patterns
  const meta = entry.metadata;
  if (!meta) return undefined;
  
  const userId = (meta as any).userId ?? (meta as any).user_id
    ?? (meta as any).user?.id ?? (meta as any).user?.userId
    ?? (meta as any).order?.userId;
  if (userId) return String(userId);

  return undefined;
}

export { groupById } from './id-grouper.js';
export { groupByTime } from './time-grouper.js';
