import {createModuleLogger} from '@itookit/common';
import type {NativeExecution} from './harness-execution-operations';
import {nativeOperationId} from './harness-execution-journal';

const log = createModuleLogger('harness-execution');
/** Naming is a recoverable metadata mutation, never another create or turn. */
export async function prepareNativeTitle(run: NativeExecution, rename: (title: string) => Promise<unknown>): Promise<void> {
    const title = run.request.title;
    if (!title || run.request.context && run.request.context.conversation.mode !== 'new' || run.journal.data.operations.turn) return;
    const started = Date.now(), {client, profile} = run.acquired;
    let result = 'skipped', code: string | undefined = 'NATIVE_RENAME_UNSUPPORTED';
    try {
        if (profile.capabilities.rename && client.rename) {
            await rename(title);
            result = 'success'; code = undefined;
        }
    } catch (error) {
        result = 'failure'; const value = (error as {code?: unknown}).code;
        code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'NATIVE_RENAME_FAILED';
    }
    log.info('harness.title', {operation: 'harness.title', operationId: nativeOperationId(run.journal.context, 'title'), stage: 'prepare', result, code, ...run.journal.context,
        nativeSessionId: run.journal.data.sessionId, durationMs: Date.now() - started});
}
