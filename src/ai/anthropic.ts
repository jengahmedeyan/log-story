import type { AIProvider, LogEvent, StoryUnit } from '../types/index.js';
import { narrativePrompt, rootCausePrompt } from '../narrative/prompt-templates.js';

// Default model - Update periodically as newer models become available
// Last updated: May 2026 (claude-sonnet-4-20250514 is current flagship)
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export function create(apiKey: string, model?: string): AIProvider {
  let Anthropic: any;
  try {
    Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
  } catch {
    throw new Error(
      '@anthropic-ai/sdk package is required for Anthropic provider. Install it: npm install @anthropic-ai/sdk'
    );
  }

  const client = new Anthropic({ apiKey });
  const modelName = model ?? DEFAULT_MODEL;

  return {
    async generateNarrative(event: LogEvent, redactionConfig): Promise<string> {
      const prompt = narrativePrompt(event, redactionConfig);
      const response = await client.messages.create({
        model: modelName,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = response.content[0];
      return block?.type === 'text' ? block.text.trim() : '';
    },

    async generateRootCause(event: LogEvent, redactionConfig): Promise<string> {
      const prompt = rootCausePrompt(event, redactionConfig);
      const response = await client.messages.create({
        model: modelName,
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = response.content[0];
      return block?.type === 'text' ? block.text.trim() : '';
    },

    async answerQuery(query: string, context: StoryUnit[]): Promise<string> {
      const contextSummary = context
        .slice(0, 10)
        .map((s) => `- [${s.outcome}] ${s.narrative}`)
        .join('\n');

      const response = await client.messages.create({
        model: modelName,
        max_tokens: 300,
        system: 'You answer questions about system logs concisely.',
        messages: [
          {
            role: 'user',
            content: `Context:\n${contextSummary}\n\nQuestion: ${query}`,
          },
        ],
      });
      const block = response.content[0];
      return block?.type === 'text' ? block.text.trim() : '';
    },

    estimateCost(tokens: number): number {
      // Claude Sonnet pricing (approximate)
      const inputTokens = tokens * 0.6;
      const outputTokens = tokens * 0.4;
      return (inputTokens / 1000) * 0.003 + (outputTokens / 1000) * 0.015;
    },
  };
}
