// @file: kernel-adapters/src/skill/compact-extractor.ts
// Compact Instructions 提取器：从 SKILL.md 中解析压缩保护区块。

import type { CompactSection } from '@itookit/tools/contracts';
import type { SkillDefinition } from '@itookit/tools/contracts';

const COMPACT_HEADING_RE = /^##\s+Compact Instructions(?:\s*\([^)]*\))?\s*$/im;
const NEXT_H2_RE = /^##\s+/m;
const RED_LINE_RE = /^\s*-\s*\[红线\]\s*/;

/**
 * 从 Markdown 文本中提取 Compact Instructions 区块。
 *
 * 返回：
 * - body：不含 compact 区块的正文
 * - compact：提取的区块（若不存在则为 null）
 */
export function extractCompactInstructions(markdown: string): {
    body: string;
    compact: CompactSection | null;
} {
    const headingMatch = COMPACT_HEADING_RE.exec(markdown);
    if (!headingMatch) {
        return { body: markdown, compact: null };
    }

    const headingStart = headingMatch.index;
    const afterHeading = markdown.slice(headingStart + headingMatch[0].length);

    // Find end of compact section (next ## heading or EOF)
    const nextH2 = NEXT_H2_RE.exec(afterHeading);
    const sectionContent = nextH2
        ? afterHeading.slice(0, nextH2.index)
        : afterHeading;

    const rawContent = headingMatch[0] + sectionContent;

    const redLines = sectionContent
        .split('\n')
        .filter((line) => RED_LINE_RE.test(line))
        .map((line) => line.replace(RED_LINE_RE, '').trim());

    const body =
        markdown.slice(0, headingStart).trimEnd() +
        (nextH2 ? '\n\n' + afterHeading.slice(nextH2.index) : '');

    return {
        body: body.trim(),
        compact: {
            marker: 'Compact Instructions',
            redLines,
            rawContent,
        },
    };
}

/**
 * 聚合多个 skill 的 compact instructions，返回注入压缩提示词的字符串。
 * 仅包含有 compact 区块且 enabled 的 skill。
 */
export function aggregateCompactInstructions(skills: SkillDefinition[]): string {
    const parts: string[] = [];

    for (const skill of skills) {
        if (!skill.enabled || !skill.compact?.redLines.length) continue;
        parts.push(
            `[${skill.name}]\n` +
                skill.compact.redLines.map((r) => `  - ${r}`).join('\n')
        );
    }

    return parts.join('\n\n');
}
