import type { AIProvider, LogEvent, StoryUnit } from '../types/index.js';
import { narrativePrompt, rootCausePrompt } from '../narrative/prompt-templates.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

export function create(apiKey: string, model?: string): AIProvider {
  let GoogleGenerativeAI: any;
  try {
    const mod = require('@google/generative-ai');
    GoogleGenerativeAI = mod.GoogleGenerativeAI ?? mod.default?.GoogleGenerativeAI;
  } catch {
    throw new Error(
      '@google/generative-ai package is required for Gemini provider. Install it: npm install @google/generative-ai'
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = model ?? DEFAULT_MODEL;

  async function generateContent(prompt: string, maxTokens: number): Promise<string> {
    const genModel = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
    });
    const result = await genModel.generateContent(prompt);
    return result.response.text().trim();
  }

  return {
    async generateNarrative(event: LogEvent): Promise<string> {
      return generateContent(narrativePrompt(event), 400);
    },

    async generateRootCause(event: LogEvent): Promise<string> {
      return generateContent(rootCausePrompt(event), 200);
    },

    async answerQuery(query: string, context: StoryUnit[]): Promise<string> {
      const contextSummary = context
        .slice(0, 10)
        .map((s) => `- [${s.outcome}] ${s.narrative}`)
        .join('\n');

      const prompt = `You answer questions about system logs concisely.\n\nContext:\n${contextSummary}\n\nQuestion: ${query}`;
      return generateContent(prompt, 300);
    },

    estimateCost(tokens: number): number {
      // Gemini pricing: Free tier has generous limits, paid tier is ~$0.00015/1K tokens
      return (tokens / 1000) * 0.00015;
    },
  };
}
