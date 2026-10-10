import type { ILLMLogger, LLMRequestLog, LLMResponseLog } from '@itookit/driver-llm/contracts';

/** Host diagnostics must not create untracked copies of personal context or its generated answers. */
export class TwinSafeLlmLogger implements ILLMLogger {
    constructor(private readonly target: ILLMLogger) {}
    logMessage(session: string, role: 'user' | 'assistant' | 'system', content: string): void {
        this.target.logMessage(session, role, sensitive(session) ? '[personal context redacted]' : content);
    }
    logRequest(session: string, request: LLMRequestLog): void {
        this.target.logRequest(session, sensitive(session) ? { provider: request.provider, model: request.model,
            messages: [], params: { contentRedacted: true } } : request);
    }
    logResponse(session: string, response: LLMResponseLog): void { this.target.logResponse(session, response); }
}
function sensitive(session: string): boolean { return /^twin-private(?:[-_:]|$)/.test(session); }
