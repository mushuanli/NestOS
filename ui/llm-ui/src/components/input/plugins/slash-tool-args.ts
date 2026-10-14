interface ToolArgResult {
    positionals: string[];
    flags: Record<string, string | number | boolean>;
}
export function parseToolArgs(raw: string): ToolArgResult {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (const ch of (raw ?? '').trim()) {
        if (inQuote) {
            if (ch === quoteChar) {
                inQuote = false;
                if (current) {
                    tokens.push(current);
                    current = '';
                }
            }
            else
                current += ch;
        }
        else if (ch === '"' || ch === "'") {
            inQuote = true;
            quoteChar = ch;
        }
        else if (ch === ' ') {
            if (current) {
                tokens.push(current);
                current = '';
            }
        }
        else {
            current += ch;
        }
    }
    if (current)
        tokens.push(current);
    const flags: Record<string, string | number | boolean> = {};
    const positionals: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].startsWith('--')) {
            const key = tokens[i].slice(2);
            const next = tokens[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                const num = Number(next);
                flags[key] = isNaN(num) ? next : num;
                i++;
            }
            else {
                flags[key] = true;
            }
        }
        else {
            positionals.push(tokens[i]);
        }
    }
    // Resolve @path and [name](path) in both positionals and flag values.
    return {
        positionals: positionals.map(resolveAtPath),
        flags: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, typeof v === 'string' ? resolveAtPath(v) : v])),
    };
}
/**
 * Resolve @path and [name](path) tokens to bare file paths.
 *
 * ChatInput's MentionPlugin inserts mentions as:
 *   @src/index.ts            → bare @-prefixed path (pre-autocomplete)
 *   [src/index.ts](./path)   → Markdown link format (post-autocomplete)
 *
 * Strips the decoration so tool args receive clean paths:
 *   /read @src/index.ts      → { path: "src/index.ts" }
 *   /read [src/index.ts](./src/index.ts) → { path: "./src/index.ts" }
 */
function resolveAtPath(token: string): string {
    // [name](path) → extract path from markdown link
    const mdLink = token.match(/^\[.*?\]\((.+?)\)$/);
    if (mdLink)
        return mdLink[1];
    // @path → strip @ prefix
    if (token.startsWith('@'))
        return token.slice(1);
    return token;
}
