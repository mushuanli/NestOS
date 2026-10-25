import {createModuleLogger} from '@itookit/common';
import type {ContextOptionsReader} from '@itookit/llm-session/contracts';
import {readInputContextDraft} from '../domain/context-draft';
import {assertContextOptionSelection, assertContextOptionsPage} from '../domain/context-options';
const log = createModuleLogger('input-context-admission');
/** Qualify the frozen selection before operation registration; dispatch still revalidates authority. */
export async function verifyInputContext(value: unknown, read: ContextOptionsReader, operationId: string): Promise<void> {
    if (value === undefined) return;
    const started = Date.now(); let code: string | undefined;
    try {
        const draft = readInputContextDraft(value)!, selection = draft.selection;
        const query = {sessionId: draft.sessionId, branchId: draft.branchId, target: draft.target,
            ...(selection.mode === 'fork' ? {bindingId: selection.sourceBindingId, checkpointRef: selection.checkpointRef} : {})};
        const page = await read(query); assertContextOptionsPage(page, query); assertContextOptionSelection(page, draft);
    } catch (error) {
        const supplied = (error as {code?: unknown})?.code;
        code = typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(supplied) ? supplied : 'CONTEXT_OPTIONS_READ_FAILED';
        throw error;
    } finally {
        try {log.info('Context preflight', {operationId, stage: 'preflight', result: code ? 'failure' : 'qualified', code, durationMs: Date.now() - started});}
        catch { /* Diagnostics cannot grant context admission. */ }
    }
}
