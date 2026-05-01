/**
 * PII (Personally Identifiable Information) redaction utilities.
 * Redacts emails, IP addresses, API keys, and common secret patterns.
 */

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_PATTERN = /\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b/gi;
const API_KEY_PATTERN = /\b(?:sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{35})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi;
const CREDIT_CARD_PATTERN = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

export interface RedactionOptions {
  redactEmails?: boolean;
  redactIPs?: boolean;
  redactAPIKeys?: boolean;
  redactTokens?: boolean;
  redactCreditCards?: boolean;
  redactSSN?: boolean;
  customPatterns?: RegExp[];
}

const DEFAULT_OPTIONS: RedactionOptions = {
  redactEmails: true,
  redactIPs: true,
  redactAPIKeys: true,
  redactTokens: true,
  redactCreditCards: true,
  redactSSN: true,
  customPatterns: [],
};

/**
 * Redact PII from a string according to the provided options.
 */
export function redactPII(text: string, options: RedactionOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let redacted = text;

  if (opts.redactEmails) {
    redacted = redacted.replace(EMAIL_PATTERN, '[EMAIL]');
  }

  if (opts.redactIPs) {
    redacted = redacted.replace(IPV4_PATTERN, '[IP]');
    redacted = redacted.replace(IPV6_PATTERN, '[IP]');
  }

  if (opts.redactAPIKeys) {
    redacted = redacted.replace(API_KEY_PATTERN, '[API_KEY]');
  }

  if (opts.redactTokens) {
    redacted = redacted.replace(JWT_PATTERN, '[JWT_TOKEN]');
    redacted = redacted.replace(BEARER_TOKEN_PATTERN, 'Bearer [TOKEN]');
  }

  if (opts.redactCreditCards) {
    redacted = redacted.replace(CREDIT_CARD_PATTERN, '[CREDIT_CARD]');
  }

  if (opts.redactSSN) {
    redacted = redacted.replace(SSN_PATTERN, '[SSN]');
  }

  // Apply custom patterns
  for (const pattern of opts.customPatterns ?? []) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
}

/**
 * Check if text contains potential PII.
 * Uses non-global regex tests to avoid stateful lastIndex issues.
 */
export function containsPII(text: string): boolean {
  return (
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(text) ||
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text) ||
    /\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b/i.test(text) ||
    /\b(?:sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{35})\b/.test(text) ||
    /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/i.test(text) ||
    /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/.test(text) ||
    /\b\d{3}-\d{2}-\d{4}\b/.test(text)
  );
}
