import type { AIProvider, LogEvent, StoryUnit } from '../types/index.js';

interface RetryConfig {
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms (default: 1000) */
  initialDelay?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Max delay cap in ms (default: 30000) */
  maxDelay?: number;
}

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelay: 1000,
  backoffMultiplier: 2,
  maxDelay: 30000,
};

function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    const status = err.status ?? err.statusCode;
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return true;
    }

    const code = err.code;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EPIPE') {
      return true;
    }
    const type = err.type;
    if (type === 'rate_limit_error' || type === 'overloaded_error') {
      return true;
    }
  }
  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  config: Required<RetryConfig>
): Promise<T> {
  let lastError: unknown;
  let delay = config.initialDelay;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === config.maxRetries || !isRetryable(error)) {
        throw error;
      }
      // Wait with jitter
      const jitter = delay * (0.5 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, jitter));
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelay);
    }
  }

  throw lastError;
}

export function withRetryBackoff(provider: AIProvider, config?: RetryConfig): AIProvider {
  const retryConfig = { ...DEFAULT_RETRY, ...config };

  return {
    async generateNarrative(event: LogEvent, redactionConfig): Promise<string> {
      return withRetry(() => provider.generateNarrative(event, redactionConfig), retryConfig);
    },

    async generateRootCause(event: LogEvent, redactionConfig): Promise<string> {
      return withRetry(() => provider.generateRootCause(event, redactionConfig), retryConfig);
    },

    async answerQuery(query: string, context: StoryUnit[]): Promise<string> {
      return withRetry(() => provider.answerQuery(query, context), retryConfig);
    },

    estimateCost(tokens: number): number {
      return provider.estimateCost(tokens);
    },
  };
}
