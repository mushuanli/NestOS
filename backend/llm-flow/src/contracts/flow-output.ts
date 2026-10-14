export interface FlowOutputEntry { name: string; value: unknown }

/** Unwrap only documented node envelopes; business objects remain intact. */
export function nodeOutputEntries(output: unknown): FlowOutputEntry[] {
    if (output === undefined) return [];
    const node = object(output);
    const outputs = object(node?.outputs);
    if (outputs) return Object.entries(outputs).map(([name, value]) => ({ name, value: artifactValue(value) }));
    const message = object(node?.message);
    if (message?.role === 'assistant') return [{ name: 'result', value: message.content }];
    return [{ name: 'result', value: output }];
}

export function flowOutputEntries(output: unknown): FlowOutputEntry[] {
    const nodes = object(object(output)?.nodes);
    if (!nodes) return nodeOutputEntries(output);
    const entries = Object.entries(nodes).flatMap(([node, value]) => nodeOutputEntries(value)
        .map(entry => ({ name: `${node} / ${entry.name}`, value: entry.value })));
    const { nodes: _nodes, ...summary } = object(output)!;
    if (Object.keys(summary).length) entries.push({ name: 'result', value: summary });
    return entries;
}

/** Session history stores this text, so reopening never depends on a live scheduler. */
export function formatFlowOutput(output: unknown): string {
    return flowOutputEntries(output).map(entry => {
        const title = entry.name.replace(/[\r\n`#]/g, ' ');
        const text = outputText(entry.value);
        if (typeof entry.value === 'string') return `### ${title}\n\n${text}`;
        const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
        return `### ${title}\n\n${fence}json\n${text}\n${fence}`;
    }).join('\n\n');
}

export function outputText(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
}

function artifactValue(value: unknown): unknown {
    const artifact = object(value);
    return artifact && typeof artifact.outputName === 'string' && typeof artifact.type === 'string'
        && Object.hasOwn(artifact, 'content') ? artifact.content : value;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
