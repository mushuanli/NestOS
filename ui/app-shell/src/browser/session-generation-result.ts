import type {ApplicationBackend} from '@itookit/app-contracts/services';
import {recoverGenerationResult} from './generation-result-recovery';

/** A durable terminal result can finish the UI even while the original reply is delayed. */
export async function sessionGenerationResult(backend: ApplicationBackend, request: Parameters<ApplicationBackend['generateText']>[0], signal: AbortSignal, disconnected: () => void): Promise<string> {
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    let awaitingReply = true, settled = false;
    signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) abort();
    const transport = backend.generateText(request).catch(error => {
        awaitingReply = false; if (settled) return new Promise<string>(() => {});
        signal.throwIfAborted();
        if (!backend.sessionResponse || typeof error?.code === 'string' && /^TEXT_/.test(error.code)) throw error;
        disconnected(); return new Promise<string>(() => {});
    });
    try {
        if (!backend.sessionResponse) return await transport;
        return await Promise.race([transport, recoverGenerationResult(backend, request.sessionId, request.operationId, controller.signal, () => awaitingReply, disconnected)]);
    } finally {settled = true; controller.abort(); signal.removeEventListener('abort', abort);}
}
