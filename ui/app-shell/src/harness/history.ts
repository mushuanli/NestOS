/** Convert native histories for display without executing or trusting their markup. */
export function historyText(turns: unknown[] | null): string {
    const lines: string[] = [];
    for (const turn of turns ?? []) {
        const items = (turn as { items?: unknown[] })?.items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const value = item as Record<string, unknown>;
            const text = typeof value.text === 'string' ? value.text : typeof value.aggregatedOutput === 'string'
                ? value.aggregatedOutput : contentText(value.content);
            if (text) lines.push(`${typeof value.type === 'string' ? value.type : ''}\n${text}`);
        }
    }
    return lines.join('\n\n').slice(-2 * 1024 * 1024);
}
function contentText(value: unknown): string {
    if (!Array.isArray(value)) return '';
    return value.map(item => item && typeof item.text === 'string' ? item.text : '').join('\n');
}
