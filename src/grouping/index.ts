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
  const fields = config?.fields ?? ['sessionId', 'traceId', 'requestId', 'jobId', 'userId', 'sourceIp'];
  const timeWindow = config?.timeWindow ?? 5000;

  const { groups: idGroups, ungrouped } = groupById(entries, fields);

  // Try to absorb ungrouped entries into nearby ID groups
  // (entries sharing userId + within time window of an existing group)
  const stillUngrouped = absorbIntoGroups(ungrouped, idGroups, timeWindow);

  // Also try to absorb single-entry ID groups into larger groups when there's
  // strong evidence they belong together (e.g., payment timeout during a user checkout)
  absorbSingletonGroups(idGroups, timeWindow);

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

  // Cross-strategy merge pass: merge groups that share entity references
  mergeGroupsBySharedEntity(allGroups);

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

/**
 * Cross-strategy merge pass: merge groups that share entity IDs in metadata.
 * This catches cases where groups formed by different strategies (requestId, jobId, time)
 * actually reference the same logical entity (e.g., same incident, same order).
 */
function mergeGroupsBySharedEntity(groups: Map<string, LogEntry[]>): void {
  // Build an index: entity ID → list of group keys
  const entityToGroups = new Map<string, string[]>();

  for (const [key, entries] of groups) {
    const entityIds = collectGroupEntityIds(entries);
    for (const eid of entityIds) {
      const existing = entityToGroups.get(eid);
      if (existing) {
        existing.push(key);
      } else {
        entityToGroups.set(eid, [key]);
      }
    }
  }

  // Merge groups that share entity IDs (time-bounded: within 10 minutes)
  const consumed = new Set<string>();
  for (const [, groupKeys] of entityToGroups) {
    if (groupKeys.length <= 1) continue;

    // Find the primary group (largest, or first ID-based group)
    const validKeys = groupKeys.filter((k) => !consumed.has(k) && groups.has(k));
    if (validKeys.length <= 1) continue;

    // Prefer ID-based groups as the merge target
    const primaryKey = validKeys.find((k) => !k.startsWith('time:') && !k.startsWith('infer'))
      ?? validKeys[0];
    const primaryEntries = groups.get(primaryKey);
    if (!primaryEntries) continue;

    const primaryBounds = getTimeBounds(primaryEntries);

    for (const otherKey of validKeys) {
      if (otherKey === primaryKey) continue;
      const otherEntries = groups.get(otherKey);
      if (!otherEntries) continue;

      // Time proximity check: groups must be within 10 minutes of each other
      const otherBounds = getTimeBounds(otherEntries);
      const gap = Math.min(
        Math.abs(otherBounds.start - primaryBounds.end),
        Math.abs(primaryBounds.start - otherBounds.end)
      );
      // Allow merge if overlapping or within 10 minutes
      const overlaps = otherBounds.start <= primaryBounds.end && otherBounds.end >= primaryBounds.start;
      if (!overlaps && gap > 600_000) continue;

      // Merge
      primaryEntries.push(...otherEntries);
      groups.delete(otherKey);
      consumed.add(otherKey);

      // Update bounds
      primaryBounds.start = Math.min(primaryBounds.start, otherBounds.start);
      primaryBounds.end = Math.max(primaryBounds.end, otherBounds.end);
    }
  }
}

function getTimeBounds(entries: LogEntry[]): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const e of entries) {
    const t = e.timestamp.getTime();
    if (t < start) start = t;
    if (t > end) end = t;
  }
  return { start, end };
}

/**
 * Collect entity IDs from a group of entries for cross-strategy matching.
 */
function collectGroupEntityIds(entries: LogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const meta = entry.metadata;
    if (!meta || typeof meta !== 'object') continue;

    for (const [key, value] of Object.entries(meta)) {
      if (typeof value !== 'string' || !value) continue;
      if (ENTITY_SKIP_FIELDS.has(key)) continue;
      if (looksLikeEntityId(value)) {
        ids.add(value);
      }
    }
  }
  return ids;
}

/** Fields whose values should never be used for entity matching in grouping. */
const ENTITY_SKIP_FIELDS = new Set([
  'message', 'msg', 'error', 'stack', 'level', 'timestamp', 'time',
  'hostname', 'host', 'path', 'url', 'method', 'status', 'statusCode',
  'duration_ms', 'duration_s', 'elapsed', 'latency', 'responseTime',
  'size_mb', 'size_gb', 'freed_mb', 'used_pct', 'port', 'reason',
  'uptime_s', 'jobs_processed', 'errors', 'error_count', 'removed',
  'pid', 'ppid', 'worker_id', 'worker', 'attempt', 'process', 'action',
  'component', 'service', 'source', 'format', 'raw', 'task', 'status',
]);

/**
 * Heuristic: does this string look like an entity/correlation ID?
 */
function looksLikeEntityId(value: string): boolean {
  // UUID (8-4-4-4-12)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  // Prefixed ID: INC-4401, job-email-77, ord_12345, req-abc
  if (/^[A-Za-z][A-Za-z0-9]*[-_][A-Za-z0-9][-A-Za-z0-9_]*$/.test(value) && value.length >= 5 && value.length <= 64) return true;
  // MongoDB ObjectId
  if (/^[0-9a-f]{24}$/i.test(value)) return true;
  return false;
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

      // Score by being inside the group's time span (suggests same flow if other signals align)
      if (entryTime >= groupStart && entryTime <= groupEnd) {
        score += 3;
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

      // Score by shared entity references in metadata (dynamic matching)
      const entryEntityIds = collectGroupEntityIds([entry]);
      if (entryEntityIds.size > 0) {
        const groupEntityIds = collectGroupEntityIds(groupEntries);
        for (const eid of entryEntityIds) {
          if (groupEntityIds.has(eid)) {
            score += 8;
            break;
          }
        }
      }

      // HTTP status sequence scoring: 401→200 or 403→200 on same user within seconds
      // should absorb (login retry flow, not separate stories)
      if (entryUserId && groupUserId && entryUserId === groupUserId) {
        const entryStatus = Number(entry.metadata?.status ?? entry.metadata?.statusCode ?? 0);
        const groupStatuses = groupEntries.map((e) => Number(e.metadata?.status ?? e.metadata?.statusCode ?? 0));
        const distToGroup = Math.min(
          Math.abs(entryTime - groupStart),
          Math.abs(entryTime - groupEnd)
        );
        // A 200 following a 401/403, or a 401/403 preceding a 200, within 10s
        if (distToGroup <= 10_000) {
          const entryIsAuth = entryStatus === 401 || entryStatus === 403;
          const entryIsSuccess = entryStatus === 200 || entryStatus === 201;
          const groupHasAuth = groupStatuses.some((s) => s === 401 || s === 403);
          const groupHasSuccess = groupStatuses.some((s) => s === 200 || s === 201);
          if ((entryIsAuth && groupHasSuccess) || (entryIsSuccess && groupHasAuth)) {
            score += 7;
          }
        }
      }

      // Cross-format pool-exhaustion scoring: postgres syslog + app JSON 503/timeout within 5s
      const entryMsg = entry.message.toLowerCase();
      const groupMsgs = groupEntries.map((e) => e.message.toLowerCase()).join(' ');
      const entryHasPool = /pool\s*exhaust|connection\s*pool/.test(entryMsg);
      const groupHasPool = /pool\s*exhaust|connection\s*pool/.test(groupMsgs);
      const entryHas503orTimeout = /\b503\b|wait\s*timeout/.test(entryMsg);
      const groupHas503orTimeout = /\b503\b|wait\s*timeout/.test(groupMsgs);
      if ((entryHasPool && groupHas503orTimeout) || (groupHasPool && entryHas503orTimeout)) {
        const distToGroup = Math.min(
          Math.abs(entryTime - groupStart),
          Math.abs(entryTime - groupEnd)
        );
        if (distToGroup <= 5000) {
          score += 8;
        }
      }

      // Penalize format mismatch (e.g., syslog entry being absorbed into JSON group)
      const entryFormat = entry.format;
      if (entryFormat) {
        const groupFormat = groupEntries.find((e) => e.format)?.format;
        if (groupFormat && entryFormat !== groupFormat) {
          score -= 2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestGroup = groupEntries;
      }
    }

    // Absorb if score is high enough (need more than just time proximity)
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

/**
 * Absorb single-entry ID groups into larger multi-entry groups when they overlap in time
 * AND share a user or entity reference.
 * This handles cases like a payment timeout (requestId:pay_9001) that belongs to
 * a user's checkout flow (userId:77).
 */
function absorbSingletonGroups(
  idGroups: Map<string, LogEntry[]>,
  timeWindow: number
): void {
  const singletons: [string, LogEntry][] = [];
  const multiGroups: [string, LogEntry[]][] = [];

  for (const [key, entries] of idGroups) {
    if (entries.length === 1) {
      singletons.push([key, entries[0]]);
    } else {
      multiGroups.push([key, entries]);
    }
  }

  if (singletons.length === 0 || multiGroups.length === 0) return;

  for (const [singleKey, entry] of singletons) {
    const entryTime = entry.timestamp.getTime();
    const entryUserId = entry.userId ?? extractUserIdFromMetadata(entry);

    for (const [, groupEntries] of multiGroups) {
      const groupStart = Math.min(...groupEntries.map((e) => e.timestamp.getTime()));
      const groupEnd = Math.max(...groupEntries.map((e) => e.timestamp.getTime()));

      // Only absorb if within the time span
      if (entryTime < groupStart || entryTime > groupEnd) continue;

      // Require shared userId to absorb — pure time overlap is not enough
      // for entries that already have their own correlation ID
      const groupUserId = groupEntries.find((e) => e.userId)?.userId
        ?? groupEntries.map((e) => extractUserIdFromMetadata(e)).find(Boolean);

      if (entryUserId && groupUserId && entryUserId === groupUserId) {
        groupEntries.push(entry);
        idGroups.delete(singleKey);
        break;
      }
    }
  }
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
