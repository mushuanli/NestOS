/** Limits use UTF-16 offsets, matching persisted source checkpoints. */
export const TWIN_CHUNK_CHARACTERS = 32 * 1024;

/** Prefer complete turns, then messages, then document blocks; always make progress. */
export function extractionEnd(text: string, offset: number): number {
    const limit = Math.min(text.length, offset + TWIN_CHUNK_CHARACTERS);
    if (limit === text.length) return limit;
    const structured = structuredCuts(text);
    for (const boundaries of [structured.turns, structured.messages, documentCuts(text)]) {
        const end = boundaries.filter(value => value > offset && value <= limit).at(-1);
        if (end !== undefined) return end;
    }
    // Do not split a surrogate pair when an individual block exceeds the limit.
    return /[\uD800-\uDBFF]/.test(text[limit - 1]) && /[\uDC00-\uDFFF]/.test(text[limit]) ? limit - 1 : limit;
}

function structuredCuts(text: string) {
    const turns: number[] = [], messages: number[] = [], stack: Array<{ char: string; start: number }> = [];
    let quoted = false, escaped = false, previousTurn: unknown, previousEnd = 0;
    if (!/^[\s]*[\[{]/.test(text)) return { turns, messages };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
        if (char === '"') { quoted = true; continue; }
        if (char === '{' || char === '[') { stack.push({ char, start: index }); continue; }
        if (char !== '}' && char !== ']') continue;
        const open = stack.pop();
        if (!open || (char === '}' ? open.char !== '{' : open.char !== '[')) return { turns: [], messages: [] };
        if (!stack.length) { turns.push(index + 1); previousTurn = undefined; continue; }
        if (char !== '}') continue;
        messages.push(index + 1);
        if (stack.length !== 1 || stack[0].char !== '[') continue;
        let record: { turn?: unknown };
        try { record = JSON.parse(text.slice(open.start, index + 1)); } catch { return { turns: [], messages: [] }; }
        if (previousEnd && record.turn !== previousTurn) turns.push(previousEnd);
        previousTurn = record.turn; previousEnd = index + 1;
    }
    return quoted || stack.length ? { turns: [], messages: [] } : { turns, messages };
}

function documentCuts(text: string): number[] {
    const cuts: number[] = [];
    let fence = '', fenceLength = 0;
    for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
        const line = match[0], marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker && !fence) { fence = marker[0]; fenceLength = marker.length; }
        else if (marker?.[0] === fence && marker.length >= fenceLength && /^ {0,3}(?:`+|~+)\s*$/.test(line)) {
            fence = ''; cuts.push(match.index + line.length);
        } else if (!fence && (/^\s*$/.test(line) || /^ {0,3}(?:#{1,6}\s|(?:---+|\*\*\*+|___+)\s*$)/.test(line))) {
            cuts.push(match.index);
        }
    }
    return cuts;
}
