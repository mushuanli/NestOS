// @file: llm-ui/utils/textUtils.ts

import type { ExecutionNode } from '@itookit/llm-session/contracts';

/**
 * 纯函数文本工具集
 * 消除 SessionRenderer、FloatingNavPanel 中的重复代码
 */

/**
 * 将 Markdown 内容转为预览文本
 */
export function getPreviewText(content: string, maxLen: number = 60): string {
    if (!content) return '';
    const plain = content
        .replace(/[\r\n]+/g, ' ')
        .replace(/[*#`_~[\]()]/g, '')
        .trim();
    return plain.length > maxLen ? plain.substring(0, maxLen) + '...' : plain;
}

/**
 * Truncate text to maxLen, replacing newlines with spaces.
 */
export function truncateText(text: string, maxLen: number): string {
    const oneLine = text.replace(/\n/g, ' ').trim();
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '\u2026' : oneLine;
}

/**
 * 递归提取执行树的输出内容
 */
export function extractExecutionOutput(node: ExecutionNode): string {
    let output = node.data?.output || '';
    for (const child of node.children || []) {
        const childOutput = extractExecutionOutput(child);
        if (childOutput) output += '\n\n' + childOutput;
    }
    return output.trim();
}
