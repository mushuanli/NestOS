/** Preserve input order, bound work and drain active operations before reporting failure. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0, failed = false;
    const worker = async () => {
        while (!failed && next < items.length) {
            const index = next++;
            try { results[index] = await run(items[index]); }
            catch (error) { failed = true; throw error; }
        }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
    const failure = workers.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return results;
}
