import {SessionCommand, type SubmissionRequest, type SubmissionReceipt} from '@itookit/llm-session/contracts';
import {createModuleLogger} from '@itookit/common';
import type {LocalApplicationServices} from '@itookit/app-contracts/services';

const log = createModuleLogger('session-submission');
/** Submit through the host-owned context without rebinding another open editor. */
export async function submitSession(services: LocalApplicationServices, supplied: SubmissionRequest): Promise<SubmissionReceipt> {
    const request = structuredClone(supplied), sessionId = request.expectedSessionId, operationId = request.submission?.id, started = Date.now();
    if (!sessionId || !operationId || !request.expectedBranch) throw Object.assign(new Error('Session submission requires explicit identity and branch'), {code: 'SUBMISSION_SCOPE_REQUIRED'});
    if (!services.acquireConversation) throw Object.assign(new Error('Conversation submission context is unavailable'), {code: 'SUBMISSION_CONTEXT_UNAVAILABLE'});
    const lease = await services.acquireConversation(sessionId);
    try {
        await lease.commandBus.execute(SessionCommand.Submit, request);
        const receipt = await lease.commandBus.execute<SubmissionReceipt>(SessionCommand.InspectSubmissionReceipt, request);
        log.info('session.submit', {sessionId, operationId, stage: 'admission', result: receipt.status, durationMs: Date.now() - started});
        return receipt;
    } catch (error) {
        const code = (error as {code?: string})?.code;
        log.warn('session.submit', {sessionId, operationId, stage: 'admission', result: 'failure', durationMs: Date.now() - started,
            code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SESSION_SUBMISSION_FAILED'});
        throw error;
    } finally {await lease.dispose();}
}
