import { readSessionInstructionQueue, type InstructionQueueSessions } from '@itookit/llm-session';
import type { Kernel } from '@itookit/durable-kernel';
import { createModuleLogger } from '@itookit/common';

/** Open only marked Sessions; the host retains their execution contexts after this lease ends. */
export async function recoverInstructionQueues(index: InstructionQueueSessions, kernel: Kernel,
    contexts: { open(sessionId: string): Promise<{ dispose(): Promise<void> }> }): Promise<void> {
    const logger = createModuleLogger('instruction-queue');
    for (const sessionId of await index.sessions()) {
        const started = Date.now();
        try {
            const state = await kernel.sessionStat(sessionId);
            if (state.phase === 'closed' || state.phase === 'closing') continue;
            if (!(await readSessionInstructionQueue(kernel, sessionId)).items.length) continue;
            const context = await contexts.open(sessionId);
            await context.dispose();
            logger.info('Instruction queue recovered', { operation: 'session.instructions', stage: 'startup-recovery',
                outcome: 'success', sessionId, operationId: sessionId, durationMs: Date.now() - started });
        } catch (error) {
            logger.warn('Instruction queue recovery deferred', { operation: 'session.instructions', stage: 'startup-recovery',
                outcome: 'failure', sessionId, operationId: sessionId, code: (error as {code?: string})?.code ?? 'QUEUE_RECOVERY',
                durationMs: Date.now() - started });
        }
    }
}
