// @file: tools/src/core/globToRegex.ts
// Shared glob-pattern to RegExp converter for GlobTool and GrepTool.

/**
 * Convert a glob pattern to a RegExp.
 * Supports **, *, ?, and character classes [abc].
 * Anchored to full path match (^ ... $).
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\x00GLOBDIR\x00')
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00GLOBSTAR\x00/g, '.*')
    .replace(/\x00GLOBDIR\x00/g, '(?:.*/)?');
  return new RegExp(`^${escaped}$`);
}
