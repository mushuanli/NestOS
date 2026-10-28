// @file: llm-ui-adapter/utils/textUtils.ts

import type { ExecutionNode } from '@itookit/llm-session/contracts';

/**
 * 纯函数文本工具集
 * 消除 SessionRenderer、FloatingNavPanel 中的重复代码
 */

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
