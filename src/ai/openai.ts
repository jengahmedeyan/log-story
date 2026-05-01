import type { AIProvider, LogEvent, StoryUnit } from '../types/index.js';
import { narrativePrompt, rootCausePrompt } from '../narrative/prompt-templates.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const COST_PER_1K_INPUT = 0.00015;
const COST_PER_1K_OUTPUT = 0.0006;

export function create(apiKey: string, model?: string): AIProvider {
  let OpenAI: any;
  try {
    OpenAI = require('openai').default ?? require('openai');
  } catch {
    throw new Error(
      'openai package is required for OpenAI provider. Install it: npm install openai'
    );
  }

  const client = new OpenAI({ apiKey });
  const modelName = model ?? DEFAULT_MODEL;

  return {
    async generateNarrative(event: LogEvent): Promise<string> {
      const prompt = narrativePrompt(event);
      const response = await client.chat.completions.create({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      });
      return response.choices[0]?.message?.content?.trim() ?? '';
    },

    async generateRootCause(event: LogEvent): Promise<string> {
      const prompt = rootCausePrompt(event);
      const response = await client.chat.completions.create({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.2,
      });
      return response.choices[0]?.message?.content?.trim() ?? '';
    },

    async answerQuery(query: string, context: StoryUnit[]): Promise<string> {
      const contextSummary = context
        .slice(0, 10)
        .map((s) => `- [${s.outcome}] ${s.narrative}`)
        .join('\n');

      const response = await client.chat.completions.create({
        model: modelName,
        messages: [
          {
            role: 'system',
            content: 'You answer questions about system logs concisely.',
          },
          {
            role: 'user',
            content: `Context:\n${contextSummary}\n\nQuestion: ${query}`,
          },
        ],
        max_tokens: 300,
        temperature: 0.4,
      });
      return response.choices[0]?.message?.content?.trim() ?? '';
    },

    estimateCost(tokens: number): number {
      // Rough estimate assuming 60% input, 40% output
      const inputTokens = tokens * 0.6;
      const outputTokens = tokens * 0.4;
      return (inputTokens / 1000) * COST_PER_1K_INPUT + (outputTokens / 1000) * COST_PER_1K_OUTPUT;
    },
  };
}
