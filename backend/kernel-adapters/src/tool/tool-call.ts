// @file: kernel-adapters/src/tool/tool-call.ts
// Shared helpers for normalising ToolCall across Anthropic and OpenAI formats.

import type { ToolCall } from '@itookit/llm-context';

/** Extract tool name (handles both Anthropic `name` and OpenAI `function.name`). */
export function getToolName(call: ToolCall): string {
    return call.function?.name ?? call.name ?? '';
}

/** Extract tool arguments (Anthropic returns `input`, OpenAI returns JSON string). */
export function getToolArgs(call: ToolCall): Record<string, unknown> {
    if (call.input) return call.input;
    if (call.function?.arguments) {
        try { return JSON.parse(call.function.arguments) as Record<string, unknown>; }
        catch { return {}; }
    }
    return {};
}

/**
 * Fallback parser for OpenAI-compatible proxies that return Claude-style
 * `<tool_call>{...}</tool_call>` blocks inside the text content instead of
 * structured `message.tool_calls`.
 *
 * Returns the parsed ToolCall array and the response text with the blocks stripped.
 * The JSON inside can use either:
 *   { "name": "foo", "arguments": { ... } }   ← proxy format
 *   { "name": "foo", "input": { ... } }        ← Anthropic native format
 */
export function extractXmlToolCalls(text: string): { calls: ToolCall[]; cleanText: string } {
    const calls: ToolCall[] = [];
    const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    const cleanText = text.replace(pattern, (_, body: string) => {
        try {
            const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
            const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
            if (!name) return '';

            // Arguments may be an object (proxy) or already a JSON string
            const rawArgs = parsed['arguments'] ?? parsed['input'] ?? {};
            const argsStr = typeof rawArgs === 'string'
                ? rawArgs
                : JSON.stringify(rawArgs);

            calls.push({
                id: `call_${crypto.randomUUID()}`,
                type: 'function',
                function: { name, arguments: argsStr },
            });
        } catch {
            // Malformed block — leave text intact by returning original match
        }
        return '';
    }).trim();

    return { calls, cleanText };
}
