import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {resolveBrowserTarget, type BrowserTarget} from '@itookit/app-contracts';
import {showNameDialog} from '../files/project-dialog';

type Target = Extract<BrowserTarget, {kind: 'remote'}>;
export interface RemoteRemovalItem {
    id: string; target: Target;
    capability?: {delete?: boolean; archive?: boolean; archiveDisabled?: boolean};
}
const log = createModuleLogger('remote-session-removal');
function removalErrorCode(error: unknown): string {
    const code = (error as {code?: unknown} | null)?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'REMOTE_REMOVAL_FAILED';
}

export function remoteRemovalItems(items: readonly {id: string; metadata: {custom: Record<string, unknown>}}[]): RemoteRemovalItem[] | undefined {
    const result: RemoteRemovalItem[] = [];
    for (const item of items) {
        const target = resolveBrowserTarget(item.id);
        if (target.kind !== 'remote' || !target.profileId || !target.nativeSessionId) return;
        result.push({id: item.id, target, capability: item.metadata.custom.nativeManagement as RemoteRemovalItem['capability']});
    }
    return result.length ? result : undefined;
}

/** Never replace deletion with archiving without the user's explicit confirmation. */
export async function confirmRemoteRemoval(items: readonly RemoteRemovalItem[], signal: AbortSignal,
    apply: (item: RemoteRemovalItem, command: {kind: 'delete' | 'archive'}) => Promise<void>): Promise<void> {
    if (!items.length || signal.aborted) return;
    const archive = items.some(item => !item.capability?.delete);
    if (archive && !items.every(item => !item.target.archived && item.capability?.archive && !item.capability.archiveDisabled))
        throw new Error(t('harness.removalUnavailable'));
    const detail = document.createElement('p');
    detail.textContent = t(archive ? 'harness.deleteToArchivePrompt' : 'harness.bulkDeletePrompt', {count: String(items.length)});
    const operationId = randomUUID(), completed = new Set<string>();
    await showNameDialog(t(archive ? 'harness.archive' : 'harness.delete'), '', signal, async () => {
        const started = Date.now();
        try {
            for (const item of items) {
                if (signal.aborted) return;
                if (completed.has(item.id)) continue;
                await apply(item, {kind: archive ? 'archive' : 'delete'}); completed.add(item.id);
            }
            log.info('remote.sessions.remove', {operationId, stage: archive ? 'archive' : 'delete', result: 'success', count: completed.size, durationMs: Date.now() - started});
        } catch (error) {
            log.warn('remote.sessions.remove', {operationId, stage: archive ? 'archive' : 'delete', result: 'failure', completed: completed.size,
                code: removalErrorCode(error), durationMs: Date.now() - started});
            throw error;
        }
    }, detail, {hideName: true, confirmLabel: t(archive ? 'harness.archive' : 'harness.delete')});
}
