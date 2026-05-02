import type { LogEntry, LogEvent, Action, ActionStatus, EventOutcome, GroupType } from '../types/index.js';
import { randomUUID } from 'crypto';

interface ActionPattern {
  type: string;
  patterns: RegExp[];
  statusPatterns: { status: ActionStatus; pattern: RegExp }[];
}

const ACTION_PATTERNS: ActionPattern[] = [
  {
    type: 'api_call',
    patterns: [
      /\b(GET|POST|PUT|DELETE|PATCH)\s+\//i,
      /calling\s+\w+\s*(api|service)/i,
      /request\s+to\s+/i,
      /fetch(ing)?\s+/i,
    ],
    statusPatterns: [
      { status: 'completed', pattern: /\b(200|201|204|success|ok|completed)\b/i },
      { status: 'failed', pattern: /\b(4\d{2}|5\d{2}|fail|error|timeout|refused)\b/i },
      { status: 'retried', pattern: /\b(retry|retrying|attempt\s+\d+)\b/i },
    ],
  },
  {
    type: 'db_operation',
    patterns: [
      /\b(query|insert|update|delete|select|find|aggregate)\b/i,
      /\b(database|db|mongo|postgres|mysql|redis)\b/i,
    ],
    statusPatterns: [
      { status: 'completed', pattern: /\b(success|found|inserted|updated|deleted)\b/i },
      { status: 'failed', pattern: /\b(fail|error|timeout|deadlock|lock)\b/i },
    ],
  },
  {
    type: 'authentication',
    patterns: [
      /\b(login|logout|auth|token|session|oauth|jwt)\b/i,
    ],
    statusPatterns: [
      { status: 'completed', pattern: /\b(success|granted|valid|authenticated)\b/i },
      { status: 'failed', pattern: /\b(fail|denied|invalid|expired|unauthorized)\b/i },
    ],
  },
  {
    type: 'file_operation',
    patterns: [
      /\b(read|write|upload|download|file|stream)\b/i,
    ],
    statusPatterns: [
      { status: 'completed', pattern: /\b(success|written|uploaded|downloaded)\b/i },
      { status: 'failed', pattern: /\b(fail|not found|permission|ENOENT)\b/i },
    ],
  },
];

function detectActions(entry: LogEntry): Action[] {
  const actions: Action[] = [];

  for (const pattern of ACTION_PATTERNS) {
    const matchesType = pattern.patterns.some((p) => p.test(entry.message));
    if (!matchesType) continue;

    let status: ActionStatus = 'started';
    for (const sp of pattern.statusPatterns) {
      if (sp.pattern.test(entry.message)) {
        status = sp.status;
        break;
      }
    }

    // Extract target (URL path, service name, etc.)
    const target = extractTarget(entry.message, pattern.type);

    actions.push({
      type: pattern.type,
      target,
      status,
      error: status === 'failed' ? extractError(entry) : undefined,
    });
  }

  return actions;
}

function extractTarget(message: string, actionType: string): string | undefined {
  if (actionType === 'api_call') {
    const urlMatch = message.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s,]+)/i);
    if (urlMatch) return urlMatch[1];
    const serviceMatch = message.match(/(?:calling|request to)\s+([^\s,]+)/i);
    if (serviceMatch) return serviceMatch[1];
  }
  return undefined;
}

function extractError(entry: LogEntry): string | undefined {
  if (entry.level === 'error' || entry.level === 'fatal') {
    return entry.message;
  }
  const errorMatch = entry.message.match(/(?:error|fail|timeout)[:\s]+(.+)/i);
  return errorMatch?.[1]?.trim();
}

function determineOutcome(entries: LogEntry[], actions: Action[]): EventOutcome {
  const hasError = entries.some((e) => e.level === 'error' || e.level === 'fatal');
  const hasFailedAction = actions.some((a) => a.status === 'failed');
  const hasSuccess = actions.some((a) => a.status === 'completed');

  // Check metadata.status fields (from key=value lines)
  const SUCCESS_STATUSES = new Set(['ok', 'success', 'done', 'complete', 'completed']);
  const FAILURE_STATUSES = new Set(['error', 'fail', 'failed', 'timeout', 'aborted']);
  const WARN_STATUSES = new Set(['warn', 'warning']);

  let hasMetadataSuccess = false;
  let hasMetadataFailure = false;
  let hasMetadataWarn = false;

  for (const e of entries) {
    const status = typeof e.metadata?.status === 'string' ? e.metadata.status.toLowerCase() : '';
    if (SUCCESS_STATUSES.has(status)) hasMetadataSuccess = true;
    if (FAILURE_STATUSES.has(status)) hasMetadataFailure = true;
    if (WARN_STATUSES.has(status)) hasMetadataWarn = true;
  }

  if (hasError || hasFailedAction || hasMetadataFailure) {
    return (hasSuccess || hasMetadataSuccess) ? 'partial' : 'failure';
  }
  if (hasMetadataWarn) return 'partial';
  if (hasSuccess || hasMetadataSuccess) return 'success';

  // Infer success from message content
  const allMessages = entries.map((e) => e.message.toLowerCase()).join(' ');
  const successSignals = /\b(success|ok|completed|created|loaded|sent|started|healthy|recovered|resolved|done|active|ready|fetched|returned|confirmed|processed)\b/;
  const failureSignals = /\b(fail|error|timeout|refused|rejected|denied|crash|panic|fatal|exhausted)\b/;

  // Check if failure signals are actually zero-count contexts (e.g., "errors=0", "failures: 0")
  const hasRealFailureSignal = failureSignals.test(allMessages) && !isZeroCountFailureSignal(allMessages);

  if (hasRealFailureSignal && !successSignals.test(allMessages)) return 'failure';
  if (successSignals.test(allMessages)) return 'success';
  if (hasRealFailureSignal) return 'failure';

  if (entries.length > 1 && !hasError) return 'success';

  if (entries.length === 1 && (entries[0].level === 'info' || entries[0].level === 'debug')) {
    return 'success';
  }

  return 'success';
}


function extractDependencies(actions: Action[]): string[] {
  const deps = new Set<string>();
  for (const action of actions) {
    if (action.target) deps.add(action.target);
  }
  return [...deps];
}

/**
 * Check if failure-signal words only appear in zero-count contexts (e.g., "errors=0", "failures: 0").
 * Returns true if ALL failure signals in the message are in zero-count form.
 */
function isZeroCountFailureSignal(message: string): boolean {
  // Match patterns like "errors=0", "error(s)=0", "failures: 0", "fail_count=0"
  const zeroCountPattern = /\b(?:fail\w*|error\w*|timeout\w*|fatal\w*|crash\w*|panic\w*)\s*[=:]\s*0\b/g;
  const failureSignals = /\b(fail|error|timeout|refused|rejected|denied|crash|panic|fatal|exhausted)\b/g;

  // Get all failure signal matches
  const allMatches = [...message.matchAll(failureSignals)];
  if (allMatches.length === 0) return false;

  // Get all zero-count matches
  const zeroMatches = [...message.matchAll(zeroCountPattern)];
  if (zeroMatches.length === 0) return false;

  // Check that every failure signal occurrence is within a zero-count context
  for (const match of allMatches) {
    const pos = match.index!;
    const isZeroCount = zeroMatches.some((zm) => {
      const zmStart = zm.index!;
      const zmEnd = zmStart + zm[0].length;
      return pos >= zmStart && pos < zmEnd;
    });
    if (!isZeroCount) return false;
  }
  return true;
}


export function buildEvent(groupKey: string, entries: LogEntry[]): LogEvent {
  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  const actions: Action[] = [];
  for (const entry of sorted) {
    actions.push(...detectActions(entry));
  }

  const startTime = sorted[0].timestamp;
  const endTime = sorted[sorted.length - 1].timestamp;

  let groupType: GroupType = 'inferred';
  if (groupKey.startsWith('traceId:') || groupKey.startsWith('requestId:') || groupKey.startsWith('jobId:')) {
    groupType = 'request';
  } else if (groupKey.startsWith('userId:')) {
    groupType = 'user';
  } else if (groupKey.startsWith('time:')) {
    groupType = 'time';
  }

  return {
    id: randomUUID(),
    entries: sorted,
    groupKey,
    groupType,
    startTime,
    endTime,
    duration: endTime.getTime() - startTime.getTime(),
    actions,
    outcome: determineOutcome(sorted, actions),
    dependencies: extractDependencies(actions),
  };
}
