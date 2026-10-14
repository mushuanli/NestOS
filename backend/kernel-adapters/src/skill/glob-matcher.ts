// @file: kernel-adapters/src/skill/glob-matcher.ts
// Glob 匹配工具，复用 @itookit/tools 中已有的 globToRegex。

import { globToRegex } from '@itookit/tools';

export { globToRegex };

/**
 * 判断给定文件路径是否匹配任一 glob 模式。
 * 支持 * ** ? {a,b} 枚举语法（{a,b} 展开为多个 pattern）。
 */
export function matchGlob(filePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        if (matchSingleGlob(filePath, pattern)) return true;
    }
    return false;
}

function matchSingleGlob(filePath: string, pattern: string): boolean {
    // Handle {a,b} enumeration by expanding into multiple patterns
    const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (braceMatch) {
        const [, prefix, alternatives, suffix] = braceMatch;
        return alternatives.split(',').some((alt) =>
            matchSingleGlob(filePath, `${prefix}${alt.trim()}${suffix}`)
        );
    }
    return globToRegex(pattern).test(filePath);
}
