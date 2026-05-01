import chalk from 'chalk';

export const OUTCOME_SYMBOLS: Record<string, string> = {
  success: chalk.green('[✓]'),
  failure: chalk.red('[✗]'),
  partial: chalk.yellow('[!]'),
  unknown: chalk.gray('[?]'),
};

export const SEVERITY_SYMBOLS: Record<string, string> = {
  info: chalk.blue('[i]'),
  warning: chalk.yellow('[!]'),
  critical: chalk.red('[✗]'),
};

export const INSIGHT_SYMBOLS: Record<string, string> = {
  low: chalk.gray('[ ]'),
  medium: chalk.yellow('[!]'),
  high: chalk.red('[!!]'),
  critical: chalk.redBright('[✗]'),
};
