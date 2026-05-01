// ─── Core Data Types ────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  metadata: Record<string, unknown>;
  source?: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  traceId?: string;
  raw: string;
}

export type ActionStatus = 'started' | 'completed' | 'failed' | 'retried';

export interface Action {
  type: string;
  target?: string;
  status: ActionStatus;
  duration?: number;
  error?: string;
}

export type EventOutcome = 'success' | 'failure' | 'partial' | 'unknown';
export type GroupType = 'request' | 'user' | 'time' | 'inferred';

export interface LogEvent {
  id: string;
  entries: LogEntry[];
  groupKey: string;
  groupType: GroupType;
  startTime: Date;
  endTime: Date;
  duration: number;
  actions: Action[];
  outcome: EventOutcome;
  dependencies: string[];
}

// ─── Causal Graph Types ─────────────────────────────────────────

export interface CausalNode {
  id: string;
  label: string;
  type: 'action' | 'outcome' | 'side_effect';
  event?: LogEvent;
  entries: LogEntry[];
  children: CausalNode[];
  outcome: EventOutcome;
}

export type StorySeverity = 'info' | 'warning' | 'critical';

export interface StoryUnit {
  id: string;
  title: string;
  events: LogEvent[];
  causalChain: CausalNode[];
  narrative: string;
  rootCause?: string;
  impact?: string;
  recommendation?: string;
  severity: StorySeverity;
  outcome: EventOutcome;
  startTime: Date;
  endTime: Date;
  duration: number;
  actors: string[];         // user IDs involved
  services: string[];       // services/endpoints involved
}

export type InsightType = 'pattern' | 'anomaly' | 'trend';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Insight {
  type: InsightType;
  title: string;
  description: string;
  occurrences: number;
  timeRange: { start: Date; end: Date };
  relatedEvents: string[];
  severity: Severity;
}

// ─── Analysis Result ────────────────────────────────────────────

export interface AnalysisResult {
  storyUnits: StoryUnit[];
  insights: Insight[];
  systemSummary: string;
  stats: AnalysisStats;
  events: LogEvent[];
}

export interface AnalysisStats {
  totalEntries: number;
  groupsFound: number;
  eventsExtracted: number;
  storiesGenerated: number;
  errorsDetected: number;
  aiCallsMade: number;
  estimatedCost: number;
  processingTimeMs: number;
}

// ─── Configuration ──────────────────────────────────────────────

export type AIProviderName = 'openai' | 'anthropic' | 'gemini' | 'local';
export type OutputFormat = 'cli' | 'json' | 'timeline';
export type Verbosity = 'minimal' | 'normal' | 'detailed';

export interface AIConfig {
  provider: AIProviderName;
  apiKey?: string;
  model?: string;
}

export interface GroupingConfig {
  timeWindow?: number;
  fields?: string[];
}

export interface OutputConfig {
  format?: OutputFormat;
  verbosity?: Verbosity;
}

export interface RedactionConfig {
  enabled?: boolean;
  redactEmails?: boolean;
  redactIPs?: boolean;
  redactAPIKeys?: boolean;
  redactTokens?: boolean;
  redactCreditCards?: boolean;
  redactSSN?: boolean;
  customPatterns?: RegExp[];
}

export interface LogStoryConfig {
  ai?: AIConfig;
  grouping?: GroupingConfig;
  output?: OutputConfig;
  streaming?: StreamConfig;
  redaction?: RedactionConfig;
}

// ─── AI Provider Interface ──────────────────────────────────────

export interface AIProvider {
  generateNarrative(event: LogEvent, redactionConfig?: RedactionConfig): Promise<string>;
  generateRootCause(event: LogEvent, redactionConfig?: RedactionConfig): Promise<string>;
  answerQuery(query: string, context: StoryUnit[]): Promise<string>;
  estimateCost(tokens: number): number;
}

// ─── Streaming Types ────────────────────────────────────────────

export interface StreamConfig {
  chunkSize?: number;
  flushInterval?: number;
  overlapSize?: number;
}

export interface StreamEvent {
  type: 'story' | 'insight' | 'progress' | 'done';
}

export interface StoryStreamEvent extends StreamEvent {
  type: 'story';
  story: StoryUnit;
}

export interface InsightStreamEvent extends StreamEvent {
  type: 'insight';
  insight: Insight;
}

export interface ProgressStreamEvent extends StreamEvent {
  type: 'progress';
  entriesProcessed: number;
  chunksProcessed: number;
  storiesGenerated: number;
}

export interface DoneStreamEvent extends StreamEvent {
  type: 'done';
  stats: AnalysisStats;
}

export type LogStoryStreamEvent = StoryStreamEvent | InsightStreamEvent | ProgressStreamEvent | DoneStreamEvent;

// ─── Parser Types ───────────────────────────────────────────────

export type LogFormat = 'winston-json' | 'pino-json' | 'plain' | 'clf' | 'unknown';

export interface ParseResult {
  entries: LogEntry[];
  detectedFormat: LogFormat;
  parseErrors: number;
}
