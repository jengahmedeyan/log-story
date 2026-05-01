import type { AIProvider, LogEvent, StoryUnit } from '../types/index.js';
import { createHash } from 'node:crypto';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 200, ttlMs = 24 * 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: move to end
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

function eventSignature(event: LogEvent): string {
  const sig = {
    actions: event.actions.map((a) => `${a.type}:${a.status}`).sort(),
    outcome: event.outcome,
    errorMessages: event.entries
      .filter((e) => e.level === 'error' || e.level === 'fatal')
      .map((e) => e.message.replace(/\d+/g, 'N').substring(0, 80))
      .sort(),
    entryCount: Math.ceil(event.entries.length / 3) * 3, // bucket by ~3
  };
  return createHash('sha256').update(JSON.stringify(sig)).digest('hex').substring(0, 16);
}

const narrativeCache = new ResponseCache();
const rootCauseCache = new ResponseCache();

export function withCache(provider: AIProvider): AIProvider {
  return {
    async generateNarrative(event: LogEvent): Promise<string> {
      const key = `narrative:${eventSignature(event)}`;
      const cached = narrativeCache.get(key);
      if (cached) return cached;

      const result = await provider.generateNarrative(event);
      narrativeCache.set(key, result);
      return result;
    },

    async generateRootCause(event: LogEvent): Promise<string> {
      const key = `rootcause:${eventSignature(event)}`;
      const cached = rootCauseCache.get(key);
      if (cached) return cached;

      const result = await provider.generateRootCause(event);
      rootCauseCache.set(key, result);
      return result;
    },

    async answerQuery(query: string, context: StoryUnit[]): Promise<string> {
      // Queries are not cached (unique questions)
      return provider.answerQuery(query, context);
    },

    estimateCost(tokens: number): number {
      return provider.estimateCost(tokens);
    },
  };
}

/**
 * Clear all AI response caches (useful for testing).
 */
export function clearCache(): void {
  narrativeCache.clear();
  rootCauseCache.clear();
}
