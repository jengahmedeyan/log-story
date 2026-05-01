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

  if (hasError || hasFailedAction) {
    return hasSuccess ? 'partial' : 'failure';
  }
  if (hasSuccess) return 'success';

  // Infer success from message content
  const allMessages = entries.map((e) => e.message.toLowerCase()).join(' ');
  const successSignals = /\b(success|ok|completed|created|loaded|sent|started|healthy|recovered|resolved|done|active|ready|fetched|returned|confirmed|processed)\b/;
  const failureSignals = /\b(fail|error|timeout|refused|rejected|denied|crash|panic|fatal|exhausted)\b/;

  if (failureSignals.test(allMessages)) return 'failure';
  if (successSignals.test(allMessages)) return 'success';

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
  if (groupKey.startsWith('traceId:') || groupKey.startsWith('requestId:')) {
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
