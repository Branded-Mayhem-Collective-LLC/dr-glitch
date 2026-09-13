/**
 * Help search: a simple, deterministic scored keyword/substring match over
 * the static topic list. No index build step — the corpus is small.
 */

import type { HelpTopic } from "./content";

export type HelpSearchResult = {
  topic: HelpTopic;
  score: number;
};

const TITLE_EXACT = 100;
const TITLE_SUBSTRING = 40;
const KEYWORD_EXACT = 25;
const KEYWORD_PREFIX = 15;
const CATEGORY_MATCH = 10;
const BODY_SUBSTRING = 8;

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9°+-]+/)
    .filter((token) => token.length > 0);
}

function scoreTopic(topic: HelpTopic, query: string, tokens: string[]): number {
  const title = topic.title.toLowerCase();
  const body = topic.body.toLowerCase();
  const keywords = topic.keywords.map((keyword) => keyword.toLowerCase());
  let score = 0;

  if (title === query) score += TITLE_EXACT;

  for (const token of tokens) {
    if (title.includes(token)) score += TITLE_SUBSTRING;
    if (keywords.some((keyword) => keyword === token)) score += KEYWORD_EXACT;
    else if (keywords.some((keyword) => keyword.startsWith(token) || token.startsWith(keyword))) {
      score += KEYWORD_PREFIX;
    }
    if (topic.category === token) score += CATEGORY_MATCH;
    if (body.includes(token)) score += BODY_SUBSTRING;
  }
  return score;
}

/**
 * Returns topics matching the query, best first. An empty query returns
 * every topic in content order so the panel can browse the full list.
 */
export function searchHelp(topics: HelpTopic[], query: string): HelpSearchResult[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return topics.map((topic) => ({ topic, score: 0 }));
  }
  const tokens = tokenize(trimmed);
  return topics
    .map((topic) => ({ topic, score: scoreTopic(topic, trimmed, tokens) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.title.localeCompare(b.topic.title));
}
