import type { AIProvider } from '../types/index.js';
import type { create as createLocal } from './local.js';
import { withCache } from './cache.js';
import { withRetryBackoff } from './retry.js';

export interface AIProviderFactory {
  create(apiKey: string, model?: string): AIProvider;
}

let openaiFactory: AIProviderFactory | null = null;
let anthropicFactory: AIProviderFactory | null = null;
let geminiFactory: AIProviderFactory | null = null;

export async function getOpenAIProvider(apiKey: string, model?: string): Promise<AIProvider> {
  if (!openaiFactory) {
    const mod = await import('./openai.js');
    openaiFactory = mod;
  }
  return openaiFactory.create(apiKey, model);
}

export async function getAnthropicProvider(apiKey: string, model?: string): Promise<AIProvider> {
  if (!anthropicFactory) {
    const mod = await import('./anthropic.js');
    anthropicFactory = mod;
  }
  return anthropicFactory.create(apiKey, model);
}

export async function getGeminiProvider(apiKey: string, model?: string): Promise<AIProvider> {
  if (!geminiFactory) {
    const mod = await import('./gemini.js');
    geminiFactory = mod;
  }
  return geminiFactory.create(apiKey, model);
}

export async function getLocalProvider(): Promise<AIProvider> {
  const { create } = await import('./local.js');
  return create();
}

export async function getProvider(
  provider: string,
  apiKey: string,
  model?: string
): Promise<AIProvider> {
  let raw: AIProvider;
  switch (provider) {
    case 'openai':
      raw = await getOpenAIProvider(apiKey, model);
      break;
    case 'anthropic':
      raw = await getAnthropicProvider(apiKey, model);
      break;
    case 'gemini':
      raw = await getGeminiProvider(apiKey, model);
      break;
    case 'local':
      raw = await getLocalProvider();
      break;
    default:
      throw new Error(`Unknown AI provider: ${provider}. Supported: openai, anthropic, gemini, local`);
  }
  return withCache(withRetryBackoff(raw));
}
