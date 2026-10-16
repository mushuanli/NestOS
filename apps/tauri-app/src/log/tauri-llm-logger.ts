import { invoke } from '@tauri-apps/api/core';
import type { ILLMLogger, LLMRequestLog, LLMResponseLog } from '@itookit/driver-llm/contracts';

interface LogRecord {
    startedAt: number; provider?: string; model?: string; messageCount?: number;
    userBytes?: number; assistantBytes?: number; status?: number;
}
/** Persist bounded metadata, with distinct desktop mode names and no conversation or credentials. */
export class TauriLLMLogger implements ILLMLogger {
    private readonly pending = new Map<string, LogRecord>();
    onResponse?: (session: string, status: number) => void;
    constructor(private readonly rootDir: string, private readonly mode: 'dev' | 'release' = import.meta.env.DEV ? 'dev' : 'release') {}
    private record(session: string): LogRecord {
        let record = this.pending.get(session);
        if (!record) { record = {startedAt: Date.now()}; this.pending.set(session, record); }
        if (this.pending.size > 128) this.pending.delete(this.pending.keys().next().value!);
        return record;
    }
    logMessage(session: string, role: 'user' | 'assistant' | 'system', content: string): void {
        const record = this.record(session), bytes = new TextEncoder().encode(content).byteLength;
        if (role === 'assistant') { record.assistantBytes = bytes; this.flush(session, record); }
        else record.userBytes = bytes;
    }
    logRequest(session: string, request: LLMRequestLog): void {
        Object.assign(this.record(session), {provider: request.provider, model: request.model, messageCount: request.messages.length});
    }
    logResponse(session: string, response: LLMResponseLog): void {
        const record = this.record(session); record.status = response.status;
        this.onResponse?.(session, response.status);
        if (response.status >= 400) this.flush(session, record);
    }
    private flush(session: string, record: LogRecord): void {
        this.pending.delete(session);
        const payload = JSON.stringify({...record, session, mode: this.mode, durationMs: Date.now() - record.startedAt}) + '\n';
        const path = `${this.rootDir}/var/log/llm/tauri-${this.mode}-${encodeURIComponent(session)}.json`;
        void invoke('fs_write_file', {path, data: Array.from(new TextEncoder().encode(payload))})
            .catch(error => console.warn('[TauriLLMLogger] write failed:', error));
    }
}
