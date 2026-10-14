import type { JsonValue, SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import type { FlowWorkspaceLease } from './run-lifecycle';

export interface WorkspaceFinalization { status: 'pending' | 'succeeded' | 'failed'; message?: string; persistenceError?: string; }
export const workspaceFinalizationKey = (taskId: string): string => `flow.run.${taskId}.workspace`;

export async function beginWorkspaceFinalization(session: SessionHandle, root: TaskHandle<JsonValue>, workspace: FlowWorkspaceLease, noticeAfterMs = 5_000) {
    const state: WorkspaceFinalization = { status: 'pending' };
    let writes: Promise<unknown> = Promise.resolve();
    const save = () => {
        const snapshot = { ...state };
        writes = writes.catch(() => undefined).then(() => session.setShared(workspaceFinalizationKey(root.id), snapshot));
        return writes;
    };
    await save();
    const notice = setTimeout(() => {
        if (state.status !== 'pending') return;
        state.message = 'Workspace cleanup is still pending; files and ownership are retained until physical shutdown is confirmed.';
        void save().catch(error => { state.persistenceError = String(error); });
    }, noticeAfterMs);
    (notice as unknown as { unref?: () => void }).unref?.();
    const completion = (async () => {
        let cleanupError: unknown;
        try {
            const exit = await root.wait().catch(() => ({ status: 'failed' }));
            await workspace.releaseCapabilities?.(root.id);
            const result = await workspace.finish(exit.status === 'succeeded' ? 'succeeded' : exit.status === 'cancelled' ? 'cancelled' : 'failed');
            state.status = 'succeeded';
            if (result?.message) state.message = result.message;
            else delete state.message;
        } catch (error) {
            cleanupError = error;
            state.status = 'failed';
            state.message = error instanceof Error ? error.message : String(error);
        }
        clearTimeout(notice);
        try { await save(); }
        catch (saveError) {
            state.persistenceError = saveError instanceof Error ? saveError.message : String(saveError);
            if (state.status === 'failed') throw new AggregateError([cleanupError, saveError], 'Workspace finalization and status persistence failed');
            throw saveError;
        }
        if (state.status === 'failed') throw cleanupError;
    })();
    void completion.catch(() => undefined);
    return { state, completion };
}
