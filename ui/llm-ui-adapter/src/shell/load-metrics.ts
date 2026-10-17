export interface SessionLoadMetrics {
    sessionId: string;
    durationMs: number;
    stages: Record<string, number>;
}

/** Measures awaited initialization, not asynchronous Markdown completion or browser paint. */
export function measureSessionLoad(sessionId: string, report?: (metrics: SessionLoadMetrics) => void) {
    const start = performance.now(), stages: Record<string, number> = {};
    let previous = start;
    return {
        mark(stage: string) {
            const now = performance.now();
            stages[stage] = Math.round(now - previous);
            previous = now;
        },
        finish() {
            try { report?.({ sessionId, durationMs: Math.round(performance.now() - start), stages }); }
            catch { /* Diagnostics must not prevent the editor from becoming ready. */ }
        },
    };
}
