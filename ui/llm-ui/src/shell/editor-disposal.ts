/** Release every resource in order, even when a preceding save or disposal fails. */
export async function disposeEditorResources(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
    const failures: unknown[] = [];
    for (const step of steps) {
        try { await step(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Editor disposal failed');
}
