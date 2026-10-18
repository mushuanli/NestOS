let enabled = true;
/** Hosts can disable verbose startup diagnostics without changing progress callbacks. */
export function setBootTraceEnabled(value: boolean): void { enabled = value; }

/** Trace startup work before awaiting it, including work that never settles. */
export async function traceBoot<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (!enabled) return operation();
    const start = performance.now();
    const elapsed = () => `${(performance.now() - start).toFixed(0)}ms`;
    console.log(`[Boot] 开始 ${label}`);
    const pending = setInterval(() => console.warn(`[Boot] 等待 ${label} (${elapsed()})`), 5_000);
    try {
        const result = await operation();
        console.log(`[Boot] 完成 ${label} (${elapsed()})`);
        return result;
    } catch (error) {
        console.error(`[Boot] 失败 ${label} (${elapsed()})`, error);
        throw error;
    } finally {
        clearInterval(pending);
    }
}
