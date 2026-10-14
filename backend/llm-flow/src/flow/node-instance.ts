/** Scheduler identity of a node iteration, independent of its Kernel task id. */
export function instanceKey(nodeId: string, iteration: number): string {
    return `${nodeId}#${iteration}`;
}

export function parseInstanceKey(key: string): { nodeId: string; iteration: number } {
    const separator = key.lastIndexOf('#');
    if (separator < 0) return { nodeId: key, iteration: 1 };
    const iteration = Number(key.slice(separator + 1));
    return {
        nodeId: key.slice(0, separator),
        iteration: Number.isInteger(iteration) && iteration > 0 ? iteration : 1,
    };
}
