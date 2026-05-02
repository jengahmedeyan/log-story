import type { LogEvent, LogEntry, StoryUnit, CausalNode, EventOutcome, StorySeverity, Action, NarrativeSource } from '../types/index.js';
import { randomUUID } from 'crypto';


export function buildStoryUnits(events: LogEvent[]): StoryUnit[] {
  const chains = buildCausalChains(events);

  let stories: StoryUnit[] = [];
  for (const chain of chains) {
    stories.push(buildStoryFromChain(chain));
  }

  stories = mergeRelatedStories(stories);

  return stories.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

function mergeRelatedStories(stories: StoryUnit[]): StoryUnit[] {
  const merged: StoryUnit[] = [];
  const consumed = new Set<string>();

  const sorted = [...stories].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(sorted[i].id)) continue;

    let current = sorted[i];
    consumed.add(current.id);

    for (let j = i + 1; j < sorted.length; j++) {
      if (consumed.has(sorted[j].id)) continue;

      if (shouldMergeStories(current, sorted[j])) {
        current = combineStories(current, sorted[j]);
        consumed.add(sorted[j].id);
      }
    }

    merged.push(current);
  }

  return merged;
}

function shouldMergeStories(a: StoryUnit, b: StoryUnit): boolean {
  const timeDiff = b.startTime.getTime() - a.endTime.getTime();

  // Database incident merge: pool exhaustion + latency/autoscaling within 15 minutes
  if (timeDiff >= 0 && timeDiff <= 900_000 && isDatabaseIncidentRelated(a, b)) {
    return true;
  }

  // Causal chain merge: if stories are part of the same operational workflow
  // (e.g., autoscale decision → instance launch → health check), merge them
  if (timeDiff >= 0 && timeDiff <= 120_000 && areCausallyRelatedStories(a, b)) {
    return true;
  }

  // Only merge overlapping stories if they share actors or have closely related components
  if (b.startTime.getTime() >= a.startTime.getTime() && b.endTime.getTime() <= a.endTime.getTime()) {
    const sharedActors = a.actors.some((actor) => b.actors.includes(actor));
    if (sharedActors) return true;
    // If both have no actors, require shared services to merge overlapping stories
    if (a.actors.length === 0 && b.actors.length === 0) {
      const sharedServices = a.services.some((s) => b.services.includes(s));
      if (sharedServices) return true;
    }
    return false;
  }

  if (a.startTime.getTime() >= b.startTime.getTime() && a.endTime.getTime() <= b.endTime.getTime()) {
    const sharedActors = a.actors.some((actor) => b.actors.includes(actor));
    if (sharedActors) return true;
    if (a.actors.length === 0 && b.actors.length === 0) {
      const sharedServices = a.services.some((s) => b.services.includes(s));
      if (sharedServices) return true;
    }
    return false;
  }

  if (b.startTime.getTime() <= a.endTime.getTime() && b.endTime.getTime() >= a.startTime.getTime()) {
    const sharedActors = a.actors.some((actor) => b.actors.includes(actor));
    if (sharedActors) return true;
    // Don't merge partially overlapping stories without shared actors
    return false;
  }

  // Must be within 2 minutes
  if (timeDiff > 120_000) return false;

  const sharedActors = a.actors.some((actor) => b.actors.includes(actor));
  if (sharedActors) return true;

  // For non-overlapping stories without actors, only merge within 30s if shared services
  if (a.actors.length === 0 && b.actors.length === 0 && timeDiff <= 30_000) {
    const sharedServices = a.services.some((s) => b.services.includes(s));
    if (sharedServices) return true;
  }

  return false;
}

/**
 * Detect if two stories are part of the same causal/operational chain.
 * E.g., autoscale decision → instance launch → health check → load balancer add.
 */
function areCausallyRelatedStories(a: StoryUnit, b: StoryUnit): boolean {
  const aMsgs = a.events.flatMap((e) => e.entries.map((en) => en.message.toLowerCase())).join(' ');
  const bMsgs = b.events.flatMap((e) => e.entries.map((en) => en.message.toLowerCase())).join(' ');

  // Autoscale workflow: scaling decision + instance launch + health check
  const autoscalePatterns = [
    /\b(scal(?:ing|e)|autoscale|launch(?:ing)?)\b/,
    /\binstance\s*#?\d+\b/,
    /\b(health.?check|load.?balancer|added to)\b/,
  ];
  const aIsAutoscale = autoscalePatterns.some((p) => p.test(aMsgs));
  const bIsAutoscale = autoscalePatterns.some((p) => p.test(bMsgs));
  if (aIsAutoscale && bIsAutoscale) return true;

  // Deployment workflow: deploy + start + active
  const deployPatterns = [
    /\b(deploy|release|rolling)\b/,
    /\bv\d+\.\d+\.\d+\b/,
    /\b(active|started|running).*nodes?\b/,
  ];
  const aIsDeploy = deployPatterns.some((p) => p.test(aMsgs));
  const bIsDeploy = deployPatterns.some((p) => p.test(bMsgs));
  if (aIsDeploy && bIsDeploy) return true;

  // Backup workflow: backup start + dump + upload + complete
  const backupPatterns = [
    /\b(backup|pg_dump|dump)\b/,
    /\b(upload|s3|compress)\b/,
  ];
  const aIsBackup = backupPatterns.some((p) => p.test(aMsgs));
  const bIsBackup = backupPatterns.some((p) => p.test(bMsgs));
  if (aIsBackup && bIsBackup) return true;

  return false;
}

/**
 * Detect if two stories are related to a database/pool-exhaustion incident.
 * Merge pool exhaustion + 503/latency/autoscaling into one incident.
 */
function isDatabaseIncidentRelated(a: StoryUnit, b: StoryUnit): boolean {
  const entryText = (en: { message: string; metadata?: Record<string, unknown> }) => {
    const parts = [en.message.toLowerCase()];
    if (en.metadata) {
      if (en.metadata.error) parts.push(String(en.metadata.error).toLowerCase());
      if (en.metadata.status) parts.push(String(en.metadata.status));
    }
    return parts.join(' ');
  };
  const aMsgs = a.events.flatMap((e) => e.entries.map(entryText)).join(' ');
  const bMsgs = b.events.flatMap((e) => e.entries.map(entryText)).join(' ');

  const poolPattern = /pool\s*exhaust|connection\s*pool/;
  const relatedPattern = /\bp99\b|latency|scal(?:e|ing)|autoscale|incident|INC-|503|wait\s*timeout/;

  const aHasPool = poolPattern.test(aMsgs);
  const bHasPool = poolPattern.test(bMsgs);
  const aHasRelated = relatedPattern.test(aMsgs);
  const bHasRelated = relatedPattern.test(bMsgs);

  // One has pool exhaustion, the other has related signals
  if ((aHasPool && bHasRelated) || (bHasPool && aHasRelated)) return true;
  // Both have pool exhaustion signals
  if (aHasPool && bHasPool) return true;

  return false;
}

function combineStories(primary: StoryUnit, secondary: StoryUnit): StoryUnit {
  const allEvents = [...primary.events, ...secondary.events]
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const allActors = [...new Set([...primary.actors, ...secondary.actors])];
  const allServices = [...new Set([...primary.services, ...secondary.services])];

  // Regenerate narrative from combined events rather than concatenating
  const combinedOutcome = determineCombinedOutcome(primary, secondary);
  const combinedSeverity = determineCombinedSeverity(primary.severity, secondary.severity);

  // Rebuild narrative from scratch using combined events
  const relationType = allEvents.some((e) => e.outcome === 'failure') ? 'temporal_cause' as const : 'same_user_flow' as const;
  const narrativeResult = generateNarrative(allEvents, combinedOutcome, relationType);

  return {
    ...primary,
    events: allEvents,
    actors: allActors,
    services: allServices,
    narrative: narrativeResult.text,
    narrativeSource: narrativeResult.source,
    rootCause: primary.rootCause ?? secondary.rootCause,
    impact: primary.impact ?? secondary.impact,
    recommendation: primary.recommendation ?? secondary.recommendation,
    severity: combinedSeverity,
    outcome: combinedOutcome,
    startTime: new Date(Math.min(primary.startTime.getTime(), secondary.startTime.getTime())),
    endTime: new Date(Math.max(primary.endTime.getTime(), secondary.endTime.getTime())),
    causalChain: [...primary.causalChain, ...secondary.causalChain],
    // Regenerate title from combined data
    title: generateTitle(allEvents, combinedOutcome),
  };
}

/**
 * If one story succeeded overall and the other failed,
 * the combined result is 'partial' (not a full failure). Only 'failure' if both failed
 * or the last event in the combined timeline failed.
 */
function determineCombinedOutcome(primary: StoryUnit, secondary: StoryUnit): EventOutcome {
  if (primary.outcome === secondary.outcome) return primary.outcome;

  if (
    (primary.outcome === 'success' && secondary.outcome === 'failure') ||
    (primary.outcome === 'failure' && secondary.outcome === 'success')
  ) {
    return 'partial';
  }

  if (primary.outcome === 'partial' || secondary.outcome === 'partial') return 'partial';

  return primary.outcome;
}

/**
 * Take the more severe of the two stories.
 */
function determineCombinedSeverity(a: StorySeverity, b: StorySeverity): StorySeverity {
  const severityOrder: Record<StorySeverity, number> = { info: 0, warning: 1, critical: 2 };
  return severityOrder[a] > severityOrder[b] ? a : b;
}

interface EventChain {
  events: LogEvent[];
  relationType: 'same_user_flow' | 'same_request' | 'temporal_cause' | 'standalone';
}

/**
 * Detect causal chains by linking events that are causally related:
 * - Same user doing sequential actions (login → checkout → support)
 * - Events where one outcome triggers another
 * - Temporal cause-effect (failure → retry → escalation)
 */
function buildCausalChains(events: LogEvent[]): EventChain[] {
  const chains: EventChain[] = [];
  const consumed = new Set<string>();

  const sorted = [...events].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(sorted[i].id)) continue;

    const chain: LogEvent[] = [sorted[i]];
    consumed.add(sorted[i].id);

    for (let j = i + 1; j < sorted.length; j++) {
      if (consumed.has(sorted[j].id)) continue;

      if (isCausallyRelated(chain, sorted[j])) {
        chain.push(sorted[j]);
        consumed.add(sorted[j].id);
      }
    }

    const relationType = chain.length > 1 ? detectRelationType(chain) : 'standalone';
    chains.push({ events: chain, relationType });
  }

  return chains;
}

/**
 * Determine if an event is causally related to an existing chain.
 */
function isCausallyRelated(chain: LogEvent[], candidate: LogEvent): boolean {
  const lastEvent = chain[chain.length - 1];
  const firstEvent = chain[0];

  const chainUserId = extractUserId(firstEvent) ?? extractUserId(lastEvent);
  const candidateUserId = extractUserId(candidate);

  if (chainUserId && candidateUserId && chainUserId === candidateUserId) {
    const timeDiff = candidate.startTime.getTime() - lastEvent.endTime.getTime();
    // Within 2 minutes = likely same user flow (e-commerce, multi-step workflows)
    if (timeDiff < 120_000 && timeDiff >= -1000) {
      return true; // Same user, close in time = same story
    }
    if (timeDiff < 300_000 && timeDiff >= 0) {
      if (isCauseEffect(lastEvent, candidate)) return true;
      if (lastEvent.outcome === 'failure' && isEscalation(candidate)) return true;
    }
  }

  const chainSessionId = extractSessionId(firstEvent) ?? extractSessionId(lastEvent);
  const candidateSessionId = extractSessionId(candidate);
  if (chainSessionId && candidateSessionId && chainSessionId === candidateSessionId) {
    const timeDiff = candidate.startTime.getTime() - lastEvent.endTime.getTime();
    if (timeDiff < 300_000 && timeDiff >= -1000) return true;
  }

  const timeDiff = candidate.startTime.getTime() - lastEvent.endTime.getTime();
  if (timeDiff >= 0 && timeDiff < 60_000) {
    if (hasSharedEntityReference(chain, candidate)) return true;

    const chainMetaUserId = extractUserIdFromMetadata(firstEvent) ?? extractUserIdFromMetadata(lastEvent);
    const candidateMetaUserId = extractUserIdFromMetadata(candidate);
    if (chainMetaUserId && candidateMetaUserId && chainMetaUserId === candidateMetaUserId) {
      return true;
    }
  }

  const candidateStart = candidate.startTime.getTime();
  const lastEnd = lastEvent.endTime.getTime();
  const lastStart = lastEvent.startTime.getTime();
  if (candidateStart >= lastStart && candidateStart <= lastEnd + 5000) {
    if (chainUserId && candidateUserId && chainUserId === candidateUserId) return true;
    // Chain has userId but candidate doesn't — chain if shared entity references
    // (e.g., payment service entry belonging to a user's checkout flow)
    if (chainUserId && !candidateUserId) {
      if (hasSharedEntityReference(chain, candidate)) return true;
    }
    // For anonymous events: chain if very close in time (<3s) even across components,
    // or if shared component within 5s.
    // BUT: don't chain events that already have distinct ID groups (requestId/jobId)
    // based purely on time proximity — they are separate operations.
    if (!chainUserId && !candidateUserId) {
      const chainHasIdGroup = firstEvent.groupType === 'request';
      const candidateHasIdGroup = candidate.groupType === 'request';
      // If both have their own ID groups but different group keys, don't chain them
      if (chainHasIdGroup && candidateHasIdGroup && firstEvent.groupKey !== candidate.groupKey) {
        return false;
      }
      // If the chain has a strong ID group, don't absorb anonymous time-grouped entries
      // unless they share an entity reference
      if (chainHasIdGroup && !candidateHasIdGroup) {
        if (hasSharedEntityReference(chain, candidate)) return true;
        return false;
      }
      const proximity = candidateStart - lastEnd;
      if (proximity <= 3000) return true;
      if (hasSharedComponent(chain, candidate)) return true;
    }
  }

  return false;
}

function isCauseEffect(eventA: LogEvent, eventB: LogEvent): boolean {
  if (eventA.outcome === 'failure') {
    const aActions = eventA.actions.map((a) => a.type).join(',');
    const bActions = eventB.actions.map((a) => a.type).join(',');
    if (aActions === bActions) return true; // Same action type = retry
  }

  if (eventA.outcome === 'failure' && isEscalation(eventB)) return true;

  return false;
}

function isEscalation(event: LogEvent): boolean {
  const messages = event.entries.map((e) => e.message.toLowerCase()).join(' ');
  return /support|ticket|escalat|alert|notify|incident/.test(messages);
}

function extractUserId(event: LogEvent): string | undefined {
  for (const entry of event.entries) {
    if (entry.userId) return entry.userId;
  }
  return extractUserIdFromMetadata(event);
}

function extractUserIdFromMetadata(event: LogEvent): string | undefined {
  for (const entry of event.entries) {
    const meta = entry.metadata;
    if (!meta) continue;
    const userId = (meta as any).userId ?? (meta as any).user_id
      ?? (meta as any).user?.id ?? (meta as any).user?.userId
      ?? (meta as any).order?.userId;
    if (userId) return String(userId);
  }
  return undefined;
}

function extractSessionId(event: LogEvent): string | undefined {
  for (const entry of event.entries) {
    if (entry.sessionId) return entry.sessionId;
    const meta = entry.metadata;
    if (meta) {
      const sessId = (meta as any).sessionId ?? (meta as any).session_id;
      if (sessId) return String(sessId);
    }
  }
  return undefined;
}

/**
 * Check if candidate event shares a component/source with events in the chain.
 * Used to avoid blindly chaining unrelated anonymous events.
 */
function hasSharedComponent(chain: LogEvent[], candidate: LogEvent): boolean {
  const chainComponents = new Set<string>();
  for (const event of chain) {
    for (const entry of event.entries) {
      if (entry.source) chainComponents.add(entry.source);
      if (entry.metadata?.component) chainComponents.add(String(entry.metadata.component));
    }
  }

  if (chainComponents.size === 0) return false;

  for (const entry of candidate.entries) {
    if (entry.source && chainComponents.has(entry.source)) return true;
    if (entry.metadata?.component && chainComponents.has(String(entry.metadata.component))) return true;
  }
  return false;
}

/**
 * Check if candidate event shares entity references with events in the chain.
 * Looks for shared orderId, cartId, paymentId, shipmentId, etc.
 */
function hasSharedEntityReference(chain: LogEvent[], candidate: LogEvent): boolean {
  const chainEntityIds = new Set<string>();
  for (const event of chain) {
    for (const entry of event.entries) {
      collectEntityIds(entry.metadata, chainEntityIds);
    }
  }

  if (chainEntityIds.size === 0) return false;

  for (const entry of candidate.entries) {
    const candidateIds = new Set<string>();
    collectEntityIds(entry.metadata, candidateIds);
    for (const id of candidateIds) {
      if (chainEntityIds.has(id)) return true;
    }
  }
  return false;
}

function collectEntityIds(obj: Record<string, unknown>, ids: Set<string>): void {
  if (!obj || typeof obj !== 'object') return;

  // Hardcoded high-signal fields (always collect regardless of shape)
  const KNOWN_ENTITY_FIELDS = [
    'orderId', 'cartId', 'paymentId', 'shipmentId', 'orderTempId',
    'order_id', 'cart_id', 'payment_id', 'shipment_id',
    'incident_id', 'ticket_id', 'connection_id', 'conn_id',
  ];
  for (const field of KNOWN_ENTITY_FIELDS) {
    if (obj[field] && typeof obj[field] === 'string') {
      ids.add(obj[field] as string);
    }
  }

  // Dynamic: scan all string values for ID-shaped patterns
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string' || !value) continue;
    // Skip known non-entity fields
    if (SKIP_ENTITY_FIELDS.has(key)) continue;
    if (looksLikeEntityId(value)) {
      ids.add(value);
    }
  }

  // Check one level of nesting
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const field of KNOWN_ENTITY_FIELDS) {
        const nested = (value as any)[field];
        if (nested && typeof nested === 'string') {
          ids.add(nested);
        }
      }
      // Dynamic scan on nested objects too
      for (const [nestedKey, nestedVal] of Object.entries(value as Record<string, unknown>)) {
        if (typeof nestedVal !== 'string' || !nestedVal) continue;
        if (SKIP_ENTITY_FIELDS.has(nestedKey)) continue;
        if (looksLikeEntityId(nestedVal)) {
          ids.add(nestedVal);
        }
      }
    }
  }
}

/** Fields whose values are never entity IDs even if they look like one. */
const SKIP_ENTITY_FIELDS = new Set([
  'message', 'msg', 'error', 'stack', 'level', 'timestamp', 'time',
  'hostname', 'host', 'path', 'url', 'method', 'status', 'statusCode',
  'duration_ms', 'duration_s', 'elapsed', 'latency', 'responseTime',
  'size_mb', 'size_gb', 'freed_mb', 'used_pct', 'port',
  'uptime_s', 'jobs_processed', 'errors', 'error_count', 'removed',
  'pid', 'ppid', 'worker_id', 'worker', 'attempt', 'process',
  'component', 'service', 'source', 'format', 'raw',
]);

/**
 * Heuristic: does this string value look like an entity/correlation ID?
 * Matches: UUIDs, prefixed IDs (INC-123, job-abc, ord_xyz), and alphanumeric tokens
 * that are clearly identifiers rather than words or numbers.
 */
function looksLikeEntityId(value: string): boolean {
  // UUID pattern (8-4-4-4-12)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  // Prefixed ID: word-or-underscore prefix + separator + alphanumeric suffix
  // e.g., INC-4401, job-email-77, ord_12345, req-abc-123
  if (/^[A-Za-z][A-Za-z0-9]*[-_][A-Za-z0-9][-A-Za-z0-9_]*$/.test(value) && value.length >= 5 && value.length <= 64) return true;
  // Short hex token (like a mongo ObjectId or short hash)
  if (/^[0-9a-f]{24}$/i.test(value)) return true;
  return false;
}

function detectRelationType(chain: LogEvent[]): EventChain['relationType'] {
  if (chain.some((e) => e.outcome === 'failure')) return 'temporal_cause';
  const users = new Set(chain.map(extractUserId).filter(Boolean));
  if (users.size === 1) return 'same_user_flow';
  return 'same_request';
}


function buildStoryFromChain(chain: EventChain): StoryUnit {
  const events = chain.events;

  const startTime = events[0].startTime;
  const endTime = events[events.length - 1].endTime;

  const outcome = determineChainOutcome(events);

  const severity = determineSeverity(events, outcome);

  const title = generateTitle(events, outcome);

  const causalChain = buildCausalNodes(events);

  const narrativeResult = generateNarrative(events, outcome, chain.relationType);

  const rootCause = outcome === 'failure' ? extractRootCause(events) : undefined;

  const impact = extractImpact(events, outcome);

  const recommendation = generateRecommendation(events, outcome);

  // Extract actors and services
  const actors = [...new Set(events.map(extractUserId).filter(Boolean))] as string[];
  const services = [...new Set(events.flatMap((e) => e.dependencies))];

  // Heartbeat with errors: override outcome to partial
  let finalOutcome = outcome;
  if (title === 'Worker Heartbeat – Errors Detected' && outcome !== 'failure') {
    finalOutcome = 'partial';
  }

  return {
    id: randomUUID(),
    title,
    events,
    causalChain,
    narrative: narrativeResult.text,
    narrativeSource: narrativeResult.source,
    rootCause,
    impact,
    recommendation,
    severity: finalOutcome !== outcome ? determineSeverity(events, finalOutcome) : severity,
    outcome: finalOutcome,
    startTime,
    endTime,
    duration: endTime.getTime() - startTime.getTime(),
    actors,
    services,
  };
}

function determineChainOutcome(events: LogEvent[]): EventOutcome {
  const hasFailure = events.some((e) => e.outcome === 'failure');
  const hasSuccess = events.some((e) => e.outcome === 'success');
  const hasPartial = events.some((e) => e.outcome === 'partial');
  const lastEvent = events[events.length - 1];

  // Check if the last entry in the chain signals success (e.g., retry chain ending in success)
  const lastEntry = lastEvent.entries[lastEvent.entries.length - 1];
  const lastEntrySignalsSuccess = lastEntry && (
    /\b(success|succeeded|completed|ok|done|delivered|sent)\b/i.test(lastEntry.message)
    || (typeof lastEntry.metadata?.status === 'string' && /^(ok|success|done|complete|completed)$/i.test(lastEntry.metadata.status))
  );

  // If last event failed but the very last entry signals success, override to partial
  if (lastEvent.outcome === 'failure' && lastEntrySignalsSuccess) return 'partial';

  // Last event determines the "final" outcome
  if (lastEvent.outcome === 'failure') return 'failure';

  // If there were failures but the story recovered (last event succeeded), it's partial
  if (hasFailure && hasSuccess && lastEvent.outcome === 'success') return 'partial';

  // If there's a failure and no final success, it's a failure
  if (hasFailure && lastEvent.outcome !== 'success') return 'failure';

  // If any event is partial, the chain is partial
  if (hasPartial) return 'partial';

  // Check all events for success signals
  const allSuccess = events.every((e) => e.outcome === 'success');
  if (allSuccess) return 'success';

  // If last event succeeded, call it success
  if (lastEvent.outcome === 'success') return 'success';

  return 'unknown';
}

function determineSeverity(events: LogEvent[], outcome: EventOutcome): StorySeverity {
  if (outcome === 'failure') {
    const hasRetries = events.some((e) =>
      e.actions.some((a) => a.status === 'retried')
    );
    const hasMultipleFailures = events.filter((e) => e.outcome === 'failure').length > 1;
    if (hasRetries || hasMultipleFailures) return 'critical';
    return 'warning';
  }
  if (outcome === 'partial') return 'warning';
  return 'info';
}

function generateTitle(events: LogEvent[], outcome: EventOutcome): string {
  const allMessages = events.flatMap((e) => e.entries.map((en) => en.message.toLowerCase()));
  const allEntries = events.flatMap((e) => e.entries);
  const allActions = events.flatMap((e) => e.actions);
  const failureDetail = detectFailureDetail(allMessages);

  // ─── Well-known user-facing flows (provide rich narrative value) ───
  if (allMessages.some((m) => /checkout|payment.?(attempt|success|fail|timeout|declined)|order.?(completed|placed|created|confirmed)/i.test(m))) {
    if (outcome === 'failure') return `Failed Checkout${failureDetail}`;
    if (outcome === 'partial') return `Partial Checkout${failureDetail}`;
    return 'Successful Checkout';
  }
  if (allMessages.some((m) => /login|auth|signup|sign.?up/.test(m))) {
    if (allMessages.some((m) => /signup|sign.?up|register/.test(m))) {
      if (outcome === 'failure') return `Failed Signup${failureDetail}`;
      return 'Successful Signup';
    }
    if (outcome === 'failure') return `Authentication Failure${failureDetail}`;
    if (outcome === 'partial') return `Login with Issues${failureDetail}`;
    if (allMessages.some((m) => /\bproducts?\b|catalog|browse/.test(m))) {
      return 'Successful Login & Product Browse';
    }
    return 'Successful Login Flow';
  }
  if (allMessages.some((m) => /support|ticket/.test(m))) {
    return 'Support Ticket Created';
  }

  // ─── Dynamic title derived from content ───
  // Try to identify the primary activity from the entries themselves
  const dynamicTitle = deriveTitleFromContent(allEntries, allMessages, allActions, outcome);
  if (dynamicTitle) {
    // Worker heartbeat with errors → append error notice
    if (dynamicTitle === 'Worker Heartbeat') {
      const hasErrors = allEntries.some(e => {
        const errCount = e.metadata?.errors ?? e.metadata?.error_count;
        return errCount !== undefined && errCount !== null && Number(errCount) > 0;
      });
      if (hasErrors) return 'Worker Heartbeat – Errors Detected';
    }
    if (outcome === 'failure' && !dynamicTitle.toLowerCase().includes('fail')) {
      return `${dynamicTitle} – Failed${failureDetail}`;
    }
    return dynamicTitle;
  }

  // Absolute fallback
  if (outcome === 'failure') return `Operation Failed${failureDetail}`;
  if (outcome === 'partial') return `Operation Partially Failed${failureDetail}`;
  return 'Operation Completed';
}

/**
 * Dynamically derive a title from log content without hardcoded patterns.
 * Uses component/source, action verbs, and key phrases from messages.
 */
function deriveTitleFromContent(
  entries: LogEntry[],
  messages: string[],
  actions: Action[],
  outcome: EventOutcome
): string | null {
  // Strategy 1: Look for a dominant component/source
  const componentCounts = new Map<string, number>();
  for (const entry of entries) {
    const comp = entry.source ?? (entry.metadata?.component as string) ?? (entry.metadata?.service as string);
    if (comp) {
      componentCounts.set(comp, (componentCounts.get(comp) ?? 0) + 1);
    }
  }

  // Strategy 2: Extract the primary action/subject from messages
  const subject = extractPrimarySubject(messages);

  // Strategy 3: Use endpoint if available
  const endpoint = actions.find((a) => a.target)?.target;

  // Get dominant component
  let dominantComponent: string | undefined;
  if (componentCounts.size > 0) {
    dominantComponent = [...componentCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0][0];
  }

  // Build title from what we found
  if (subject) {
    return subject;
  }

  if (endpoint) {
    if (outcome === 'failure') return `Failed Request to ${endpoint}`;
    return `Request to ${endpoint}`;
  }

  if (dominantComponent) {
    return formatComponentTitle(dominantComponent, messages, outcome);
  }

  return null;
}

/**
 * Extract a meaningful subject/action phrase from messages.
 * Looks for the most descriptive action happening in the log entries.
 */
function extractPrimarySubject(messages: string[]): string | null {
  const joined = messages.join(' ');

  // Look for common operational verbs and their objects to form a title
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    // Deployment & releases
    [/\b(deploy(?:ment|ing)?)\b.*?\b(v[\d.]+|complete|initiated|rollback)/i, () => 'Deployment'],
    // Backup operations
    [/\b(backup|pg_dump|dump)\b/i, () => 'Database Backup'],
    // Scaling
    [/\b(scal(?:ing|e))\s*(out|in|up|down)\b/i, () => 'Autoscaling'],
    [/\b(autoscale|scaling policy)\b/i, () => 'Autoscaling'],
    // Database operations (application-level: migrations, queries)
    [/\b(migration)\b/i, () => 'Database Migration'],
    [/\b(replication|replica|standby)\b/i, () => 'Replication Event'],
    // Cleanup operations
    [/\b(cleanup|prune|expired.*removed|removed.*expired)/i, () => 'Cleanup'],
    // Monitoring
    [/\b(worker\s*heartbeat|heartbeat\s*ok|jobs_processed)\b/i, () => 'Worker Heartbeat'],
    [/\b(health.?check)\b/i, () => 'Health Check'],
    [/\b(heartbeat)\b/i, () => 'Worker Heartbeat'],
    [/\b(rate.?limit|throttl)/i, () => 'Rate Limit'],
    [/\b(metrics|aggregat)/i, () => 'Metrics Collection'],
    // Service lifecycle
    [/\b(start(?:ed|ing)?)\b.*\b(server|service|worker|process)\b/i, () => 'Service Start'],
    [/\bserver\b.*\b(start|listen)/i, () => 'Service Start'],
    [/\b(stop|shutdown|graceful)/i, () => 'Service Stop'],
    // Network & connection
    [/\b(connection.?pool|pool.?exhaust)/i, () => 'Connection Pool Issue'],
    [/\b(memory|oom|heap)\b.*\b(usage|limit|exceeded|pressure)/i, () => 'Memory Pressure'],
    // Cron / scheduled tasks
    [/\b(running scheduled|cron|@reboot)/i, () => 'Scheduled Task'],
    // Notification & messaging
    [/\b(notification|email|sms|alert).*(sent|dispatch|deliver|failed)/i, () => 'Notification'],
    [/\b(report|summary).*(generat|dispatch|ready)/i, () => 'Report Generation'],
    // Data fetching / API
    [/\b(product|catalog|inventory)\b/i, () => 'Data Retrieval'],
    [/\bdashboard\b/i, () => 'Dashboard Load'],
  ];

  for (const [pattern, titleFn] of patterns) {
    if (pattern.test(joined)) {
      return titleFn(joined.match(pattern)!);
    }
  }

  return null;
}

/**
 * Format a title from a component name and context.
 */
function formatComponentTitle(component: string, messages: string[], outcome: EventOutcome): string {
  // Normalize the component name into something readable
  const name = component
    .replace(/[-_./]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

  // Try to extract what the component was doing
  const firstMessage = messages[0] ?? '';
  const action = getActionVerb(firstMessage, outcome);

  if (action) {
    return `${name}: ${action}`;
  }
  return `${name} Activity`;
}

function getActionVerb(message: string, outcome?: EventOutcome): string | null {
  const verbPatterns: [RegExp, string, boolean?][] = [
    [/\bstarted\b/i, 'Started'],
    [/\bstopped?\b/i, 'Stopped'],
    [/\bcompleted?\b/i, 'Completed'],
    [/\bfailed\b/i, 'Failed', true],
    [/\bconnect/i, 'Connected'],
    [/\binitialized?\b/i, 'Initialized'],
    [/\btimeout\b/i, 'Timed Out', true],
    [/\bretry/i, 'Retried'],
  ];
  for (const [pattern, verb, isNegative] of verbPatterns) {
    if (pattern.test(message)) {
      // Don't use negative verbs when the overall outcome recovered
      if (isNegative && outcome === 'partial') return 'Recovered';
      if (isNegative && outcome === 'success') continue;
      return verb;
    }
  }
  return null;
}

/**
 * Detect the specific cause of failure from log messages to add to the title.
 */
function detectFailureDetail(messages: string[]): string {
  const joined = messages.join(' ');
  if (/timeout/i.test(joined)) {
    const provider = extractPattern(messages, /provider[=:\s]+(\w+)/i);
    if (provider) return ` – ${capitalize(provider)} Timeout`;
    return ' – Timeout';
  }
  if (/connection.?pool.?exhaust/i.test(joined)) return ' – Connection Pool Exhausted';
  if (/rate.?limit/i.test(joined)) return ' – Rate Limited';
  if (/unauthorized|403|401/i.test(joined)) return ' – Unauthorized';
  if (/not.?found|404/i.test(joined)) return ' – Not Found';
  return '';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function generateNarrative(
  events: LogEvent[],
  outcome: EventOutcome,
  relationType: EventChain['relationType']
): { text: string; source: NarrativeSource } {
  const allEntries = events.flatMap((e) => e.entries);
  const allMessages = allEntries.map((e) => e.message);
  const allActions = events.flatMap((e) => e.actions);

  const parts: string[] = [];

  // Identify the actor
  const userId = extractUserId(events[0]);
  const actor = userId ? `User ${userId}` : 'The system';

  const retryCount = allActions.filter((a) => a.status === 'retried').length;

  // Build the story
  if (isCheckoutFlow(allMessages)) {
    return { text: buildCheckoutNarrative(actor, allMessages, allActions, outcome, retryCount), source: 'template' };
  }
  if (isAuthFlow(allMessages)) {
    return { text: buildAuthNarrative(actor, allMessages, allEntries, outcome), source: 'template' };
  }
  if (isSignupFlow(allMessages)) {
    return { text: buildSignupNarrative(actor, allMessages, outcome), source: 'template' };
  }
  if (isDeploymentFlow(allMessages)) {
    return { text: buildDeploymentNarrative(allMessages, allEntries, outcome), source: 'template' };
  }
  if (isDataFetch(allMessages)) {
    return { text: buildDataFetchNarrative(actor, allMessages, allEntries, outcome), source: 'template' };
  }
  if (isInfraEvent(allMessages)) {
    return { text: buildInfraNarrative(allMessages, outcome), source: 'template' };
  }
  if (isBackgroundJob(allMessages, allEntries)) {
    return { text: buildJobNarrative(actor, allMessages, allEntries, outcome, retryCount), source: 'template' };
  }
  if (isRetryChain(allEntries, retryCount)) {
    return { text: buildRetryChainNarrative(actor, allMessages, allEntries, outcome, retryCount), source: 'template' };
  }

  // Generic narrative — build from actual content
  if (outcome === 'failure') {
    const errorEntries = allEntries.filter((e) => e.level === 'error' || e.level === 'fatal');
    const retryEntries = allEntries.filter((e) => /\bretry\b/i.test(e.message) || (e.metadata?.attempt !== undefined && Number(e.metadata.attempt) > 1));
    const errorDetail = errorEntries.length > 0
      ? (typeof errorEntries[0].metadata?.error === 'string' ? errorEntries[0].metadata.error : errorEntries[0].message)
      : undefined;

    if (retryCount > 0 || retryEntries.length > 0) {
      // Determine total attempts: prefer explicit attempt metadata, else count entries
      const maxAttemptFromMeta = Math.max(
        ...allEntries.map((e) => Number(e.metadata?.attempt) || 0)
      );
      const attempts = maxAttemptFromMeta > 0 ? maxAttemptFromMeta : Math.max(retryCount + 1, 2);
      parts.push(`${actor} attempted an operation that failed after ${attempts} attempts.`);
    } else {
      parts.push(`${actor} performed an operation that failed.`);
    }
    if (errorDetail) {
      parts.push(`Error: ${errorDetail}`);
    } else if (errorEntries.length > 0) {
      parts.push(`Error: ${errorEntries[0].message}`);
    }
  } else {
    // Build a narrative from the log content rather than a generic statement
    const narrative = buildGenericNarrative(actor, allEntries, allActions, outcome);
    return { text: narrative, source: 'generic' };
  }

  return { text: parts.join(' '), source: 'generic' };
}

/**
 * Build a meaningful narrative from arbitrary log entries by summarizing
 * what happened based on the actual messages, components, and actions.
 */
function buildGenericNarrative(actor: string, entries: LogEntry[], actions: Action[], outcome: EventOutcome): string {
  const parts: string[] = [];

  // 1. Check for scheduled task metadata (from cron key=value lines)
  const taskEntry = entries.find((e) => e.metadata?.task);
  if (taskEntry) {
    const task = taskEntry.metadata.task;
    // Resolve final status: prefer terminal states from any entry in the group, fall back to outcome
    const TERMINAL_STATUSES = new Set(['done', 'complete', 'completed', 'ok', 'success', 'failed', 'error', 'timeout']);
    const allStatuses = entries
      .map((e) => typeof e.metadata?.status === 'string' ? e.metadata.status.toLowerCase() : '')
      .filter(Boolean);
    const finalStatus = allStatuses.find((s) => TERMINAL_STATUSES.has(s))
      ?? (outcome === 'success' ? 'completed' : outcome === 'failure' ? 'failed' : outcome === 'partial' ? 'completed with warnings' : 'completed');
    const durationMs = extractDurationFromEntries(entries);
    const durationStr = durationMs ? ` in ${formatDurationMs(durationMs)}` : '';
    const countsStr = extractCountsFromEntries(entries);
    return `Scheduled task '${task}' ${finalStatus}${durationStr}.${countsStr ? ' ' + countsStr : ''}`;
  }

  // 2. Check for worker heartbeat entries with error/job counts
  const heartbeatEntries = entries.filter((e) => /heartbeat/i.test(e.message) || e.metadata?.jobs_processed !== undefined);
  if (heartbeatEntries.length > 0) {
    const workerParts: string[] = [];
    for (const e of heartbeatEntries) {
      const workerId = e.metadata?.worker_id ?? e.metadata?.worker ?? 'unknown';
      const jobs = e.metadata?.jobs_processed;
      const errors = e.metadata?.errors ?? e.metadata?.error_count;
      if (jobs !== undefined) {
        const errStr = (errors !== undefined && Number(errors) > 0) ? `, errors=${errors}` : '';
        workerParts.push(`Worker ${workerId}: ${jobs} jobs processed${errStr}`);
      }
    }
    if (workerParts.length > 0) {
      return `Worker heartbeat received. ${workerParts.join('. ')}.`;
    }
  }

  // 3. Find the most informative message: prefer warn/error, then most metadata, then longest
  const sortedByInfo = [...entries].sort((a, b) => {
    const levelScore = (e: LogEntry) => (e.level === 'error' || e.level === 'fatal') ? 2 : e.level === 'warn' ? 1 : 0;
    const metaCount = (e: LogEntry) => Object.keys(e.metadata ?? {}).length;
    const ls = levelScore(b) - levelScore(a);
    if (ls !== 0) return ls;
    const ms = metaCount(b) - metaCount(a);
    if (ms !== 0) return ms;
    return b.message.length - a.message.length;
  });

  // Get unique components involved
  const components = [...new Set(
    entries.map((e) => e.source ?? (e.metadata?.component as string)).filter(Boolean)
  )] as string[];

  const durationMs = extractDurationFromEntries(entries);
  const durationStr = durationMs ? ` Duration: ${formatDurationMs(durationMs)}.` : '';
  const countsStr = extractCountsFromEntries(entries);

  // Get key events — skip low-information entries, pick the most meaningful ones
  const keyMessages = sortedByInfo
    .filter((e) => e.level !== 'debug')
    .map((e) => e.message)
    .filter((m) => m.length > 10); // Skip trivial messages

  // Summarize: who/what + what happened
  if (components.length > 0) {
    const componentStr = components.slice(0, 3).join(', ');
    if (keyMessages.length <= 3) {
      parts.push(`[${componentStr}] ${keyMessages[0] ?? 'Activity detected'}`);
      if (keyMessages.length > 1) {
        parts.push(keyMessages[keyMessages.length - 1]);
      }
    } else {
      // Use timestamp-sorted entries for Started/Ended (not info-sorted keyMessages)
      const timeSorted = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const firstMsg = timeSorted[0]?.message ?? keyMessages[keyMessages.length - 1];
      const lastMsg = timeSorted[timeSorted.length - 1]?.message ?? keyMessages[0];
      parts.push(`${actor} triggered activity across ${componentStr}.`);
      parts.push(`Started: ${truncateMessage(firstMsg)}`);
      parts.push(`Ended: ${truncateMessage(lastMsg)}`);
    }
  } else if (keyMessages.length > 0) {
    if (keyMessages.length === 1) {
      parts.push(`${actor}: ${keyMessages[0]}`);
    } else {
      parts.push(`${actor}: ${truncateMessage(keyMessages[0])}`);
      if (outcome === 'partial') {
        const warnMsgs = entries.filter((e) => e.level === 'warn').map((e) => e.message);
        if (warnMsgs.length > 0) {
          parts.push(`Warning: ${truncateMessage(warnMsgs[0])}`);
        }
      }
    }
  } else {
    parts.push(`${actor} completed an operation successfully.`);
  }

  if (durationStr) parts.push(durationStr.trim());
  if (countsStr) parts.push(countsStr);

  return parts.join(' ');
}

function extractDurationFromEntries(entries: LogEntry[]): number | undefined {
  for (const e of entries) {
    const meta = e.metadata ?? {};
    if (meta.duration_ms !== undefined) return Number(meta.duration_ms);
    if (meta.duration_s !== undefined) return Number(meta.duration_s) * 1000;
    if (meta.elapsed !== undefined) return Number(meta.elapsed);
  }
  return undefined;
}

function extractCountsFromEntries(entries: LogEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    const meta = e.metadata ?? {};
    if (meta.removed || meta.evicted || meta.pruned) {
      const count = meta.removed ?? meta.evicted ?? meta.pruned;
      parts.push(`${count} items removed`);
    }
    if (meta.freed_mb) {
      parts.push(`${meta.freed_mb}MB freed`);
    }
    if (meta.size_mb || meta.size_gb) {
      const size = meta.size_mb ? `${meta.size_mb}MB` : `${meta.size_gb}GB`;
      parts.push(`size: ${size}`);
    }
    if (meta.recipients || meta.emails_queued || meta.queued) {
      const count = meta.recipients ?? meta.emails_queued ?? meta.queued;
      parts.push(`${count} queued`);
    }
    if (parts.length > 0) break; // Use first entry with counts
  }
  return parts.join(', ');
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncateMessage(msg: string, maxLen = 100): string {
  if (msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen - 3) + '...';
}


function buildCheckoutNarrative(
  actor: string,
  messages: string[],
  actions: Action[],
  outcome: EventOutcome,
  retryCount: number
): string {
  const parts: string[] = [];

  const paymentProvider = extractPattern(messages, /provider[=:\s]+(\w+)/i) ?? 'the payment service';
  const amount = extractPattern(messages, /(?:amount|total)[=:\s]+([\d.]+)/i);
  const orderId = extractPattern(messages, /order[_\s]?id[=:\s]+(\w+)/i);
  const amountStr = amount ? ` ($${amount})` : '';

  if (outcome === 'failure') {
    if (retryCount > 0) {
      parts.push(
        `${actor} attempted to checkout${amountStr}. Payment failed ${retryCount + 1} times via ${paymentProvider} due to timeouts.`
      );
    } else {
      parts.push(`${actor} attempted to checkout${amountStr}, but payment via ${paymentProvider} failed.`);
    }

    if (messages.some((m) => /ticket|support/.test(m.toLowerCase()))) {
      parts.push(`A support ticket was created as a result.`);
    }
  } else if (outcome === 'partial') {
    // Mixed: some failures then eventual success, or success then failure
    const failedAttempts = actions.filter((a) => a.status === 'failed' || a.status === 'retried').length;
    if (failedAttempts > 0 && orderId) {
      parts.push(
        `${actor} checked out${amountStr} after ${failedAttempts} failed payment attempt${failedAttempts > 1 ? 's' : ''} via ${paymentProvider}. Order ${orderId} was eventually created.`
      );
    } else if (failedAttempts > 0) {
      parts.push(
        `${actor} attempted to checkout${amountStr}. Payment failed ${failedAttempts} time${failedAttempts > 1 ? 's' : ''} via ${paymentProvider} before succeeding.`
      );
    } else {
      parts.push(`${actor} completed a checkout${amountStr} with partial issues.`);
    }
  } else {
    // Full success
    parts.push(`${actor} completed checkout${amountStr} successfully via ${paymentProvider}.`);
    if (orderId) {
      parts.push(`Order ${orderId} was created.`);
    }
  }

  return parts.join(' ');
}

function buildDeploymentNarrative(messages: string[], entries: LogEntry[], outcome: EventOutcome): string {
  const parts: string[] = [];

  // Extract version info
  const versions = [...new Set(messages.flatMap((m) => {
    const matches = m.match(/\bv(\d+\.\d+\.\d+)\b/gi);
    return matches ?? [];
  }))];

  if (outcome === 'failure') {
    parts.push('Deployment failed.');
    if (versions.length > 0) {
      parts.push(`Target version: ${versions[versions.length - 1]}.`);
    }
    return parts.join(' ');
  }

  if (versions.length >= 2) {
    parts.push(`Rolling deployment from ${versions[0]} to ${versions[versions.length - 1]}.`);
  } else if (versions.length === 1) {
    parts.push(`Deployed version ${versions[0]}.`);
  } else {
    parts.push('Deployment completed.');
  }

  // Check for zero-downtime signals
  const joined = messages.join(' ').toLowerCase();
  if (/zero.?downtime|rolling|graceful|drain/i.test(joined)) {
    parts.push('Zero-downtime rolling update.');
  }

  // Check for completion signals
  if (/active.*all.*nodes|all.*nodes.*active/i.test(joined)) {
    parts.push('All nodes active.');
  }

  return parts.join(' ');
}

function buildAuthNarrative(actor: string, messages: string[], entries: LogEntry[], outcome: EventOutcome): string {
  const allLower = messages.map(m => m.toLowerCase()).join(' ');
  const has401 = /\b401\b/.test(allLower);
  const has403 = /\b403\b/.test(allLower);
  const has200 = /\b200\b/.test(allLower);

  // 403 = authorization failure regardless of overall outcome
  if (has403) {
    const resource = extractPattern(messages, /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s,]+)/i) ?? 'the requested resource';
    return `${actor} was denied access to ${resource} — insufficient permissions.`;
  }

  // 401 present = authentication failure
  if (has401 && has200) {
    // Mixed: initial failure then success
    return `${actor} initially failed authentication (401) then successfully logged in after retry.`;
  }

  if (has401 || outcome === 'failure') {
    return `${actor} failed to authenticate — invalid credentials.`;
  }

  const parts: string[] = [];
  parts.push(`${actor} successfully logged in`);

  // Only mention additional actions if they are explicitly in the log messages
  const hasProductBrowse = messages.some((m) => /\bproducts?\b/i.test(m) && /\b(GET|fetch|browse|returned?)\b/i.test(m));
  if (hasProductBrowse) {
    parts[0] += ' and browsed products';
  }

  return parts[0] + '.';
}

function buildSignupNarrative(actor: string, messages: string[], outcome: EventOutcome): string {
  const email = extractPattern(messages, /email[=:\s]+(\S+)/i);
  if (outcome === 'failure') {
    return `A new user signup attempt${email ? ` (${email})` : ''} failed.`;
  }
  return `A new user${email ? ` (${email})` : ''} signed up successfully.`;
}

function buildDataFetchNarrative(
  actor: string,
  messages: string[],
  entries: LogEntry[],
  outcome: EventOutcome
): string {
  const hasCacheMiss = messages.some((m) => /cache\s*miss/i.test(m));
  const latency = extractPattern(messages, /latency[=:\s]+(\d+ms)/i);
  const itemCount = extractPattern(messages, /(?:returned?|found|items?)[=:\s]+(\d+)/i);

  const parts: string[] = [];
  parts.push(`${actor} fetched data`);

  if (hasCacheMiss) {
    parts[0] += ' (cache miss, fell back to database)';
  }

  if (itemCount) {
    parts.push(`${itemCount} results returned`);
  }
  if (latency) {
    parts.push(`response time: ${latency}`);
  }

  return parts.join('. ') + '.';
}

function buildInfraNarrative(messages: string[], outcome: EventOutcome): string {
  const joinedLower = messages.join(' ').toLowerCase();

  if (joinedLower.includes('memory')) {
    const pct = extractPattern(messages, /(\d+)%/);
    return `High memory usage detected${pct ? ` at ${pct}%` : ''}. This may indicate a memory leak or traffic spike.`;
  }
  if (joinedLower.includes('connection pool')) {
    if (joinedLower.includes('recovered') || joinedLower.includes('restored')) {
      return `Connection pool was temporarily exhausted but recovered automatically.`;
    }
    return `Database connection pool exhausted. New connections are being rejected.`;
  }
  if (joinedLower.includes('server') && joinedLower.includes('start') && !joinedLower.includes('deploy')) {
    const port = extractPattern(messages, /port\s+(\d+)/i);
    return `Server started${port ? ` on port ${port}` : ''}.`;
  }

  return `Infrastructure event detected: ${messages[0]}`;
}

// ─── Causal Node Building ───────────────────────────────────────

function buildCausalNodes(events: LogEvent[]): CausalNode[] {
  return events.map((event) => ({
    id: event.id,
    label: event.entries[0]?.message ?? 'unknown',
    type: event.outcome === 'failure' ? 'outcome' as const : 'action' as const,
    event,
    entries: event.entries,
    children: [],
    outcome: event.outcome,
  }));
}

// ─── Root Cause & Impact Extraction ─────────────────────────────

function extractRootCause(events: LogEvent[]): string {
  // Find the first error that starts the failure chain
  for (const event of events) {
    const errorEntries = event.entries.filter(
      (e) => e.level === 'error' || e.level === 'fatal'
    );
    if (errorEntries.length > 0) {
      const entry = errorEntries[0];
      // Check both message and metadata.error for root cause patterns
      const metaError = typeof entry.metadata?.error === 'string' ? entry.metadata.error : '';
      const msg = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|pool\s*exhaust|connection.?pool/i.test(metaError) ? metaError : entry.message;
      // Try to extract a clean, human-readable root cause
      if (/timeout/i.test(msg) && !/ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(msg)) {
        const provider = extractPattern([msg], /provider[=:\s]+(\w+)/i);
        const service = extractPattern([msg], /(?:service|api|endpoint)[=:\s]+(\S+)/i);
        const target = provider ?? service ?? 'upstream service';
        return `${capitalize(target)} timeout — not responding within SLA`;
      }
      if (/ECONNREFUSED/i.test(msg)) {
        const host = extractHostFromError(msg);
        return `Connection refused to ${host} — target service is down or not listening`;
      }
      if (/ECONNRESET/i.test(msg)) {
        const host = extractHostFromError(msg);
        return `Connection reset by ${host} — target service closed the connection unexpectedly`;
      }
      if (/ETIMEDOUT/i.test(msg)) {
        const host = extractHostFromError(msg);
        return `Connection timed out to ${host} — network issue or service overloaded`;
      }
      if (/connection.?pool/i.test(msg) && !/provider[=:]/i.test(msg)) {
        return `Database connection pool exhausted — a long-running query may be holding connections`;
      }
      if (/pool\s*exhaust/i.test(msg) && !/provider[=:]/i.test(msg)) {
        return `Database connection pool exhausted — a long-running query may be holding connections`;
      }
      if (/out of memory|oom/i.test(msg)) {
        return `Out of memory — process exceeded available memory`;
      }
      // Default: use the error message directly (it's already meaningful)
      return msg;
    }
  }

  // No error entries — check for warnings that indicate the cause
  for (const event of events) {
    const warnEntries = event.entries.filter((e) => e.level === 'warn');
    if (warnEntries.length > 0) {
      return warnEntries[0].message;
    }
  }

  return 'Unable to determine root cause from available logs';
}

function extractHostFromError(msg: string): string {
  // Try to extract host:port from patterns like "connect ECONNREFUSED relay.mailservice.io:587"
  const hostPortMatch = msg.match(/(?:connect\s+)?(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\s+(\S+)/i);
  if (hostPortMatch) return hostPortMatch[1];
  // Try general host pattern
  const hostMatch = msg.match(/(?:host|address|to)\s+(\S+)/i);
  if (hostMatch) return hostMatch[1];
  return 'unknown host';
}

function extractImpact(events: LogEvent[], outcome: EventOutcome): string | undefined {
  if (outcome === 'success') return undefined;

  const allMessages = events.flatMap((e) => e.entries.map((en) => en.message));
  const allLower = allMessages.join(' ').toLowerCase();

  // User-facing failures
  if (/checkout.?fail|payment.?fail|order.?fail/i.test(allLower)) {
    const userId = extractUserId(events[0]);
    return `Failed transaction${userId ? ` for user ${userId}` : ''} — potential revenue loss and user frustration`;
  }
  if (/ticket|support|escalat/i.test(allLower)) {
    return 'Customer escalation triggered — support team notified';
  }
  // Infrastructure failures
  if (/connection.?pool|pool.?exhaust/i.test(allLower)) {
    return 'Service degradation — new requests may be rejected';
  }
  if (/5\d{2}|service.?unavailable|503/i.test(allLower)) {
    return 'Service degradation — requests returning errors to clients';
  }
  if (/timeout/i.test(allLower)) {
    return 'Increased latency — downstream consumers may be affected';
  }
  if (/disk|storage|quota/i.test(allLower)) {
    return 'Storage pressure — writes may fail if not addressed';
  }
  if (/replication|replica.?lag/i.test(allLower)) {
    return 'Read replicas serving stale data';
  }

  return undefined;
}

function generateRecommendation(events: LogEvent[], outcome: EventOutcome): string | undefined {
  if (outcome === 'success') return undefined;

  const allMessages = events.flatMap((e) => e.entries.map((en) => en.message.toLowerCase()));
  const joined = allMessages.join(' ');

  if (/timeout/i.test(joined)) {
    return 'Consider implementing a circuit breaker pattern and checking upstream service health';
  }
  if (/connection.?pool|pool.?exhaust/i.test(joined)) {
    return 'Review connection pool sizing and implement connection recycling';
  }
  if (/memory|oom|heap/i.test(joined)) {
    return 'Profile memory usage and check for leaks; consider scaling horizontally';
  }
  if (/disk.?space|storage|quota/i.test(joined)) {
    return 'Review retention policies and expand storage capacity';
  }
  if (/rate.?limit|throttl|429/i.test(joined)) {
    return 'Implement request queuing or negotiate higher rate limits with the upstream service';
  }
  if (/replication|replica.?lag/i.test(joined)) {
    return 'Investigate primary write load and network latency to replicas';
  }
  if (/auth|unauthorized|forbidden|403|401/i.test(joined)) {
    return 'Verify credentials and access policies; check for expired tokens';
  }

  return undefined;
}

// ─── Helpers ────────────────────────────────────────────────────

function isCheckoutFlow(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /checkout|payment.?(attempt|success|fail|timeout|declined)|order.?(completed|placed|created|confirmed)/i.test(joined);
}

function isDeploymentFlow(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /\b(deploy|deploying|deployment|rolling.?update|release)\b/.test(joined)
    || (joined.includes('v') && /\bv\d+\.\d+\.\d+\b/.test(joined) && /\b(started?|active|running|launched)\b/.test(joined));
}

function isAuthFlow(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /login|authenticat|auth.*(?:success|fail|token|credential)/.test(joined) && !/signup|sign.?up|register/.test(joined);
}

function isSignupFlow(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /signup|sign.?up|register/.test(joined);
}

function isDataFetch(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /\b(GET|fetch|product|dashboard|response.?sent|returned?\s+\d+)\b/i.test(joined)
    && !/checkout|payment|login|auth/.test(joined);
}

function isInfraEvent(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /server.?start|connection.?pool|memory.?usage|health.?check/.test(joined);
}

function extractPattern(messages: string[], pattern: RegExp): string | undefined {
  for (const msg of messages) {
    const match = msg.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

// ─── Mid-Tier Flow Detectors ────────────────────────────────────

function isBackgroundJob(messages: string[], entries: LogEntry[]): boolean {
  // Must have job_id or task_id in metadata, or explicit job-related messages
  const hasJobId = entries.some((e) => e.jobId || e.metadata?.job_id || e.metadata?.jid);
  if (hasJobId) return true;
  const joined = messages.join(' ').toLowerCase();
  return /\b(job|worker|queue|dispatch|enqueue|dequeue)\b.*\b(start|fail|complete|retry|process)/i.test(joined)
    && !/checkout|payment|deploy/.test(joined);
}

function isRetryChain(entries: LogEntry[], retryCount: number): boolean {
  // At least 2 entries with retry/attempt signals
  if (retryCount >= 1) return true;
  const retrySignals = entries.filter((e) =>
    /\bretry\b|\bretrying\b|\battempt\s*\d+/i.test(e.message)
    || (e.metadata?.attempt !== undefined && Number(e.metadata.attempt) > 1)
  );
  return retrySignals.length >= 1 && entries.length >= 2;
}

// ─── Mid-Tier Narrative Builders ────────────────────────────────

function buildJobNarrative(
  actor: string,
  messages: string[],
  entries: LogEntry[],
  outcome: EventOutcome,
  retryCount: number
): string {
  const parts: string[] = [];

  // Extract job identity
  const jobId = entries.find((e) => e.jobId)?.jobId
    ?? entries.find((e) => e.metadata?.job_id)?.metadata?.job_id as string
    ?? 'unknown';
  const jobType = extractPattern(messages, /\b(email|notification|payment|sync|import|export|cleanup|report)\b/i);

  // Extract error details
  const errorEntry = entries.find((e) => e.level === 'error' || e.level === 'fatal');
  const errorDetail = errorEntry
    ? (typeof errorEntry.metadata?.error === 'string' ? errorEntry.metadata.error : errorEntry.message)
    : undefined;

  // Max attempt from metadata or message content
  const maxAttempt = Math.max(...entries.map((e) => Number(e.metadata?.attempt) || 0));
  const maxRetryFromMessage = Math.max(0, ...messages.map((m) => {
    const match = m.match(/retry\s*#?(\d+)/i);
    return match ? Number(match[1]) : 0;
  }));
  const totalAttempts = maxAttempt > 0 ? maxAttempt : maxRetryFromMessage > 0 ? maxRetryFromMessage + 1 : retryCount + 1;

  const jobLabel = jobType ? `${jobType} job` : 'background job';

  if (outcome === 'failure') {
    if (totalAttempts > 1) {
      parts.push(`${capitalize(jobLabel)} '${jobId}' failed after ${totalAttempts} attempts.`);
    } else {
      parts.push(`${capitalize(jobLabel)} '${jobId}' failed.`);
    }
    if (errorDetail) {
      parts.push(`Error: ${truncateMessage(errorDetail, 120)}`);
    }
  } else if (outcome === 'partial') {
    parts.push(`${capitalize(jobLabel)} '${jobId}' completed with warnings after ${totalAttempts} attempt${totalAttempts > 1 ? 's' : ''}.`);
  } else {
    const durationMs = extractDurationFromEntries(entries);
    const durationStr = durationMs ? ` in ${formatDurationMs(durationMs)}` : '';
    parts.push(`${capitalize(jobLabel)} '${jobId}' completed successfully${durationStr}.`);
  }

  return parts.join(' ');
}

function buildRetryChainNarrative(
  actor: string,
  messages: string[],
  entries: LogEntry[],
  outcome: EventOutcome,
  retryCount: number
): string {
  const parts: string[] = [];

  // Determine what's being retried
  const operation = extractPattern(messages, /(?:retry(?:ing)?|retried)\s+(\w[\w\s]*\w)/i)
    ?? extractPattern(messages, /(\w+)\s+(?:failed|timeout|error)/i)
    ?? 'operation';

  // Get attempt count
  const maxAttempt = Math.max(...entries.map((e) => Number(e.metadata?.attempt) || 0));
  const totalAttempts = maxAttempt > 0 ? maxAttempt : Math.max(retryCount + 1, entries.length);

  // Get error from metadata or messages
  const errorEntry = entries.find((e) => e.level === 'error' || e.level === 'fatal');
  const errorDetail = errorEntry
    ? (typeof errorEntry.metadata?.error === 'string' ? errorEntry.metadata.error : errorEntry.message)
    : undefined;

  if (outcome === 'failure') {
    parts.push(`${actor} retried ${operation} ${totalAttempts} times but all attempts failed.`);
    if (errorDetail) {
      parts.push(`Final error: ${truncateMessage(errorDetail, 100)}`);
    }
  } else if (outcome === 'partial' || outcome === 'success') {
    parts.push(`${actor} retried ${operation} and succeeded after ${totalAttempts} attempt${totalAttempts > 1 ? 's' : ''}.`);
  } else {
    parts.push(`${actor} retried ${operation} ${totalAttempts} times.`);
  }

  return parts.join(' ');
}
