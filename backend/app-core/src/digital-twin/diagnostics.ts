/** Keep an actionable error message without persisting credentials or stack traces. */
export class TwinDiagnosticError extends Error {
    readonly detail: string;
    readonly tokens?: number;
    constructor(code: string, cause: unknown, tokens?: number) {
        super(code);
        this.detail = diagnosticDetail(cause);
        if (Number.isSafeInteger(tokens) && tokens! >= 0) this.tokens = tokens;
    }
}
export function diagnosticDetail(error: unknown): string {
    if (error instanceof TwinDiagnosticError) return error.detail;
    const value = error as { message?: unknown; code?: unknown } | null;
    const code = typeof value?.code === 'string' && /^[A-Z0-9_-]{1,80}$/i.test(value.code) ? value.code + ': ' : '';
    const message = typeof value?.message === 'string' ? value.message : typeof error === 'string' ? error : '';
    return (code + message)
        .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
        .replace(/((?:api[_-]?key|access[_-]?token|authorization|password)\s*["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[endpoint]')
        .slice(0, 600);
}

export function traceAnalysis(job: { sessionId: string; connectionId: string }, stage: string, details: Record<string, string | number | boolean | undefined> = {}): void {
    const event = { time: new Date().toISOString(), sessionId: job.sessionId, connectionId: job.connectionId, stage, ...details };
    if (stage === 'failed') console.warn('[DigitalTwin]', event);
    else console.info('[DigitalTwin]', event);
}
