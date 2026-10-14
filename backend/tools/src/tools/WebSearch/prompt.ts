// @file: tools/src/tools/WebSearch/prompt.ts
// Prompt constants for WebSearch tool.

export const WEB_SEARCH_TOOL_NAME = 'WebSearch';

export const DESCRIPTION = `Perform web searches and return results.
- Input: query string, optional allowed_domains and blocked_domains arrays
- Output: search results with title, URL, and snippet for each result
- Supports domain filtering for allowed and blocked domains`;
