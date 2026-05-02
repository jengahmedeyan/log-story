import type { LogEntry } from '../types/index.js';

/**
 * Keywords extracted from log messages for similarity comparison.
 */
interface KeywordVector {
  keywords: Set<string>;
  entry: LogEntry;
}

// Action patterns to extract as keywords
const ACTION_KEYWORDS = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|login|logout|auth|token|connect|disconnect|timeout|retry|error|fail|success|complete|start|stop|send|receive|upload|download|fetch|cache|queue|publish|subscribe)\b/gi;

// Service/resource patterns
const SERVICE_KEYWORDS = /\b([a-z]+-(?:service|api|db|cache|queue|worker|gateway))\b/gi;

// HTTP paths
const PATH_PATTERN = /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s]+)/i;

// Error codes
const ERROR_CODE_PATTERN = /\b([45]\d{2})\b/g;

/**
 * Extract keyword vector from a log entry for similarity matching.
 */
function extractKeywords(entry: LogEntry): Set<string> {
  const keywords = new Set<string>();
  const msg = entry.message.toLowerCase();

  // Action keywords
  const actions = msg.match(ACTION_KEYWORDS);
  if (actions) {
    for (const a of actions) keywords.add(a.toLowerCase());
  }

  // Service names
  const services = msg.match(SERVICE_KEYWORDS);
  if (services) {
    for (const s of services) keywords.add(s.toLowerCase());
  }

  // HTTP paths (normalized to first two segments)
  const pathMatch = entry.message.match(PATH_PATTERN);
  if (pathMatch) {
    const segments = pathMatch[1].split('/').slice(0, 3).join('/');
    keywords.add(`path:${segments}`);
  }

  // Error codes
  const errors = msg.match(ERROR_CODE_PATTERN);
  if (errors) {
    for (const e of errors) keywords.add(`status:${e}`);
  }

  // Level as a keyword
  keywords.add(`level:${entry.level}`);

  // Service from metadata
  if (entry.metadata?.service) {
    keywords.add(`service:${String(entry.metadata.service).toLowerCase()}`);
  }

  // Component/source as a keyword (important for syslog-style grouping)
  if (entry.source) {
    keywords.add(`component:${entry.source.toLowerCase()}`);
  }
  if (entry.metadata?.component) {
    keywords.add(`component:${String(entry.metadata.component).toLowerCase()}`);
  }

  return keywords;
}

/**
 * Compute Jaccard similarity between two keyword sets.
 * Returns value between 0 and 1.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Group log entries by content similarity using keyword-based Jaccard distance.
 *
 * Algorithm:
 * 1. Extract keyword vectors from each entry
 * 2. Greedy clustering: assign each entry to the most similar existing cluster
 *    or start a new cluster if similarity is below threshold
 * 3. Split any resulting cluster with large time gaps into sub-clusters
 *
 * @param entries - Ungrouped log entries
 * @param threshold - Similarity threshold (0-1, default 0.4)
 * @returns Map of group key to entries
 */
export function groupByInference(
  entries: LogEntry[],
  threshold = 0.4
): Map<string, LogEntry[]> {
  if (entries.length === 0) return new Map();

  const vectors: KeywordVector[] = entries.map((entry) => ({
    keywords: extractKeywords(entry),
    entry,
  }));

  // Clusters: each cluster has a merged keyword set (centroid) and entries
  const clusters: { centroid: Set<string>; entries: LogEntry[] }[] = [];

  for (const vec of vectors) {
    let bestClusterIdx = -1;
    let bestSimilarity = 0;

    // Find the most similar cluster
    for (let i = 0; i < clusters.length; i++) {
      const sim = jaccardSimilarity(vec.keywords, clusters[i].centroid);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestClusterIdx = i;
      }
    }

    if (bestClusterIdx >= 0 && bestSimilarity >= threshold) {
      // Check component mismatch: if entry has a distinct component not in cluster, raise threshold
      const entryComponents = [...vec.keywords].filter(k => k.startsWith('component:'));
      const clusterComponents = [...clusters[bestClusterIdx].centroid].filter(k => k.startsWith('component:'));
      if (entryComponents.length > 0 && clusterComponents.length === 0) {
        // Entry has a component but cluster doesn't — require higher similarity
        if (bestSimilarity < 0.6) {
          clusters.push({ centroid: new Set(vec.keywords), entries: [vec.entry] });
          continue;
        }
      }
      // Check time proximity: don't add to cluster if too far from latest entry
      const cluster = clusters[bestClusterIdx];
      const lastEntry = cluster.entries[cluster.entries.length - 1];
      const timeGap = Math.abs(vec.entry.timestamp.getTime() - lastEntry.timestamp.getTime());
      if (timeGap <= 300_000) { // 5 minute max gap within a cluster
        cluster.entries.push(vec.entry);
        for (const kw of vec.keywords) {
          cluster.centroid.add(kw);
        }
      } else {
        // Too far in time — start a new cluster even though keywords match
        clusters.push({
          centroid: new Set(vec.keywords),
          entries: [vec.entry],
        });
      }
    } else {
      // Start a new cluster
      clusters.push({
        centroid: new Set(vec.keywords),
        entries: [vec.entry],
      });
    }
  }

  // Convert to Map, only include clusters with 2+ entries (singletons stay ungrouped)
  const groups = new Map<string, LogEntry[]>();
  let idx = 0;
  for (const cluster of clusters) {
    if (cluster.entries.length >= 2) {
      groups.set(`inferred-${idx++}`, cluster.entries);
    } else {
      // Singletons get their own group to avoid data loss
      groups.set(`inferred-single-${idx++}`, cluster.entries);
    }
  }

  return groups;
}
