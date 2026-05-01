import type { AnalysisResult, OutputFormat } from '../types/index.js';
import { formatCLI } from './cli-formatter.js';
import { formatJSON } from './json-formatter.js';
import { formatTimeline } from './timeline.js';

export function format(result: AnalysisResult, outputFormat: OutputFormat = 'cli'): string {
  switch (outputFormat) {
    case 'json':
      return formatJSON(result);
    case 'timeline':
      return formatTimeline(result.storyUnits);
    case 'cli':
    default:
      return formatCLI(result);
  }
}

export { formatCLI } from './cli-formatter.js';
export { formatJSON } from './json-formatter.js';
export { formatTimeline } from './timeline.js';
