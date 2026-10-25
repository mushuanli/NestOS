import type {IndependentCallDescendantPage} from '@itookit/llm-session/contracts';

/** Reject mismatched identities and non-advancing cursors before mounting controls. */
export function assertDescendantPage(page: IndependentCallDescendantPage, rootId: string | undefined, afterTaskId?: string): void {
    if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < page.items.length || page.items.length > 50) throw invalid();
    let previous = afterTaskId; const seen = new Set<string>(), ordered = afterTaskId !== undefined || page.nextAfterTaskId !== undefined;
    for (const item of page.items) {
        if (!item || typeof item.taskId !== 'string' || !item.taskId || !item.parentTaskId || item.taskId === rootId
            || seen.has(item.taskId) || ordered && previous !== undefined && item.taskId <= previous || item.executionState?.id !== item.taskId
            || !Number.isSafeInteger(item.executionState.controlEpoch) || item.executionState.controlEpoch < 0) throw invalid();
        seen.add(item.taskId); previous = item.taskId;
    }
    if (page.nextAfterTaskId !== undefined && (!page.items.length || page.nextAfterTaskId !== previous)) throw invalid();
}
function invalid(): Error {return Object.assign(new Error('CALL_VIEW_SCOPE_MISMATCH'), {code: 'CALL_VIEW_SCOPE_MISMATCH'});}
