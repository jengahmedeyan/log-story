import type { LogEvent, LogEntry, StoryUnit, CausalNode, EventOutcome, StorySeverity, Action } from '../types/index.js';
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

  if (b.startTime.getTime() >= a.startTime.getTime() && b.endTime.getTime() <= a.endTime.getTime()) {
    return true;
  }

  if (a.startTime.getTime() >= b.startTime.getTime() && a.endTime.getTime() <= b.endTime.getTime()) {
    return true;
  }

  if (b.startTime.getTime() <= a.endTime.getTime() && b.endTime.getTime() >= a.startTime.getTime()) {
    const sharedActors = a.actors.some((actor) => b.actors.includes(actor));
    if (sharedActors) return true;
    const sharedServices = a.services.some((s) => b.services.includes(s));
    if (sharedServices) return true;
    if (a.actors.length === 0 || b.actors.length === 0) return true;
  }

  // Must be within 2 minutes
  if (timeDiff > 120_000) return false;

  const sharedActors = a.actors.some((actor) => b.actors.includes(actor));
  if (sharedActors) return true;

  if (timeDiff <= 60_000) {
    const sharedServices = a.services.some((s) => b.services.includes(s));
    if (sharedServices) return true;
  }

  if (a.actors.length === 0 && b.actors.length === 0 && timeDiff <= 30_000) {
    const sharedServices = a.services.some((s) => b.services.includes(s));
    if (sharedServices) return true;
    if (a.title.split(' ').slice(1).join(' ') === b.title.split(' ').slice(1).join(' ')) return true;
  }

  return false;
}

function combineStories(primary: StoryUnit, secondary: StoryUnit): StoryUnit {
  const allEvents = [...primary.events, ...secondary.events]
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const allActors = [...new Set([...primary.actors, ...secondary.actors])];
  const allServices = [...new Set([...primary.services, ...secondary.services])];

  // Keep the more severe/informative story's narrative
  const keepPrimary = primary.severity >= secondary.severity;
  const narrative = keepPrimary
    ? primary.narrative + (secondary.narrative !== primary.narrative ? ' ' + secondary.narrative : '')
    : secondary.narrative + ' ' + primary.narrative;

  return {
    ...primary,
    events: allEvents,
    actors: allActors,
    services: allServices,
    narrative: narrative.trim(),
    rootCause: primary.rootCause ?? secondary.rootCause,
    impact: primary.impact ?? secondary.impact,
    recommendation: primary.recommendation ?? secondary.recommendation,
    severity: determineCombinedSeverity(primary.severity, secondary.severity),
    outcome: determineCombinedOutcome(primary, secondary),
    startTime: new Date(Math.min(primary.startTime.getTime(), secondary.startTime.getTime())),
    endTime: new Date(Math.max(primary.endTime.getTime(), secondary.endTime.getTime())),
    causalChain: [...primary.causalChain, ...secondary.causalChain],
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
    if (!chainUserId && !candidateUserId) return true;
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
  const idFields = ['orderId', 'cartId', 'paymentId', 'shipmentId', 'orderTempId', 'order_id', 'cart_id'];
  for (const field of idFields) {
    if (obj[field] && typeof obj[field] === 'string') {
      ids.add(obj[field] as string);
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const field of idFields) {
        const nested = (value as any)[field];
        if (nested && typeof nested === 'string') {
          ids.add(nested);
        }
      }
    }
  }
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

  const narrative = generateNarrative(events, outcome, chain.relationType);

  const rootCause = outcome === 'failure' ? extractRootCause(events) : undefined;

  const impact = extractImpact(events, outcome);

  const recommendation = generateRecommendation(events, outcome);

  // Extract actors and services
  const actors = [...new Set(events.map(extractUserId).filter(Boolean))] as string[];
  const services = [...new Set(events.flatMap((e) => e.dependencies))];

  return {
    id: randomUUID(),
    title,
    events,
    causalChain,
    narrative,
    rootCause,
    impact,
    recommendation,
    severity,
    outcome,
    startTime,
    endTime,
    duration: endTime.getTime() - startTime.getTime(),
    actors,
    services,
  };
}

function determineChainOutcome(events: LogEvent[]): EventOutcome {
  const hasFailure = events.some((e) => e.outcome === 'failure');
  const lastEvent = events[events.length - 1];

  if (hasFailure && lastEvent.outcome !== 'success') return 'failure';
  if (hasFailure && lastEvent.outcome === 'success') return 'partial';

  // Check all events for success signals
  const allSuccess = events.every((e) => e.outcome === 'success');
  if (allSuccess) return 'success';

  // If last event succeeded, call it success
  if (lastEvent.outcome === 'success') return 'success';

  return 'success';
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
  const allActions = events.flatMap((e) => e.actions);

  // Detect primary activity
  if (allMessages.some((m) => /checkout|order|payment/.test(m))) {
    if (outcome === 'failure') return 'Checkout failure (critical incident)';
    return 'Successful checkout';
  }
  if (allMessages.some((m) => /login|auth|signup|sign.?up/.test(m))) {
    if (allMessages.some((m) => /signup|sign.?up|register/.test(m))) {
      return outcome === 'failure' ? 'Failed signup attempt' : 'Successful signup';
    }
    if (outcome === 'failure') return 'Authentication failure';
    return 'Successful login flow';
  }
  if (allMessages.some((m) => /product|catalog|inventory/.test(m))) {
    return 'Product data retrieval';
  }
  if (allMessages.some((m) => /dashboard/.test(m))) {
    return 'Dashboard loaded';
  }
  if (allMessages.some((m) => /support|ticket/.test(m))) {
    return 'Support ticket created';
  }
  if (allMessages.some((m) => /server.?start|started/.test(m))) {
    return 'Server initialization';
  }
  if (allMessages.some((m) => /connection.?pool|memory/.test(m))) {
    if (outcome === 'failure') return 'Infrastructure issue';
    return 'Infrastructure event';
  }

  // Fallback: use first endpoint or action type
  const endpoint = allActions.find((a) => a.target)?.target;
  if (endpoint) {
    return outcome === 'failure' ? `Failed request to ${endpoint}` : `Request to ${endpoint}`;
  }

  return outcome === 'failure' ? 'Operation failed' : 'Operation completed';
}

function generateNarrative(
  events: LogEvent[],
  outcome: EventOutcome,
  relationType: EventChain['relationType']
): string {
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
    return buildCheckoutNarrative(actor, allMessages, allActions, outcome, retryCount);
  }
  if (isAuthFlow(allMessages)) {
    return buildAuthNarrative(actor, allMessages, outcome);
  }
  if (isSignupFlow(allMessages)) {
    return buildSignupNarrative(actor, allMessages, outcome);
  }
  if (isDataFetch(allMessages)) {
    return buildDataFetchNarrative(actor, allMessages, allEntries, outcome);
  }
  if (isInfraEvent(allMessages)) {
    return buildInfraNarrative(allMessages, outcome);
  }

  // Generic narrative
  if (outcome === 'failure') {
    const errorMsgs = allEntries.filter((e) => e.level === 'error').map((e) => e.message);
    parts.push(`${actor} performed an operation that failed.`);
    if (errorMsgs.length > 0) {
      parts.push(`Error: ${errorMsgs[0]}`);
    }
  } else {
    parts.push(`${actor} completed an operation successfully.`);
  }

  return parts.join(' ');
}


function buildCheckoutNarrative(
  actor: string,
  messages: string[],
  actions: Action[],
  outcome: EventOutcome,
  retryCount: number
): string {
  const parts: string[] = [];

  parts.push(`${actor} attempted to complete a checkout.`);

  // Detect payment details
  const paymentProvider = extractPattern(messages, /provider[=:\s]+(\w+)/i) ?? 'the payment service';
  const amount = extractPattern(messages, /(?:amount|total)[=:\s]+([\d.]+)/i);

  if (amount) {
    parts.push(`The cart total was $${amount}.`);
  }

  if (outcome === 'failure') {
    if (retryCount > 0) {
      parts.push(
        `The system attempted payment ${retryCount + 1} times via ${paymentProvider}, but all attempts failed due to timeouts.`
      );
    } else {
      parts.push(`Payment via ${paymentProvider} failed.`);
    }

    // Check for escalation (support ticket)
    if (messages.some((m) => /ticket|support/.test(m.toLowerCase()))) {
      parts.push(`This triggered a support ticket creation.`);
    }
  } else {
    parts.push(`Payment was processed successfully via ${paymentProvider}.`);
    const orderId = extractPattern(messages, /order[_\s]?id[=:\s]+(\w+)/i);
    if (orderId) {
      parts.push(`Order ${orderId} was created.`);
    }
  }

  return parts.join(' ');
}

function buildAuthNarrative(actor: string, messages: string[], outcome: EventOutcome): string {
  if (outcome === 'failure') {
    return `${actor} attempted to log in but authentication failed.`;
  }
  const joinedLower = messages.join(' ').toLowerCase();
  if (joinedLower.includes('cache miss') || joinedLower.includes('product')) {
    return `${actor} successfully logged in and fetched product data with a cache miss, causing a database fallback. Performance remained within acceptable range.`;
  }
  return `${actor} successfully logged in.`;
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
  if (joinedLower.includes('server') && joinedLower.includes('start')) {
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
      const msg = errorEntries[0].message;
      // Clean up the message to be a clear root cause
      if (/timeout/i.test(msg)) {
        const provider = extractPattern([msg], /provider[=:\s]+(\w+)/i);
        return `External payment provider${provider ? ` (${provider})` : ''} timeout — upstream service not responding within SLA`;
      }
      if (/connection.?pool/i.test(msg)) {
        return `Database connection pool exhausted — too many concurrent connections`;
      }
      return msg;
    }
  }
  return 'Unable to determine root cause from available logs';
}

function extractImpact(events: LogEvent[], outcome: EventOutcome): string | undefined {
  if (outcome === 'success') return undefined;

  const allMessages = events.flatMap((e) => e.entries.map((en) => en.message));

  if (allMessages.some((m) => /checkout.?fail|order.?fail/i.test(m))) {
    const userId = extractUserId(events[0]);
    return `Failed transaction${userId ? ` for user ${userId}` : ''} — potential revenue loss and user frustration`;
  }
  if (allMessages.some((m) => /ticket|support/i.test(m))) {
    return 'Customer escalation triggered — support team notified';
  }
  if (allMessages.some((m) => /connection.?pool/i.test(m))) {
    return 'Service degradation — new requests may be rejected';
  }

  return undefined;
}

function generateRecommendation(events: LogEvent[], outcome: EventOutcome): string | undefined {
  if (outcome === 'success') return undefined;

  const allMessages = events.flatMap((e) => e.entries.map((en) => en.message.toLowerCase()));

  if (allMessages.some((m) => m.includes('timeout'))) {
    return 'Consider implementing a circuit breaker pattern and checking upstream service health';
  }
  if (allMessages.some((m) => m.includes('connection pool'))) {
    return 'Review connection pool sizing and implement connection recycling';
  }
  if (allMessages.some((m) => m.includes('memory'))) {
    return 'Profile memory usage and check for leaks; consider scaling horizontally';
  }

  return undefined;
}

// ─── Helpers ────────────────────────────────────────────────────

function isCheckoutFlow(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /checkout|payment|order.?complet/.test(joined);
}

function isAuthFlow(messages: string[]): boolean {
  const joined = messages.join(' ').toLowerCase();
  return /login|auth.*success|session/.test(joined) && !/signup|sign.?up|register/.test(joined);
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
