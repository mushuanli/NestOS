import type { HarnessClient, HarnessConversationJournal, HarnessConversationPort, HarnessConversationSnapshot, HarnessReceipt } from '@itookit/piagent-driver';
import type { RemoteConversationStore } from './remote-conversation-store';
import {formatDefaultFileTitle, t} from '@itookit/common';
import {reportRemoteFailure} from './remote-diagnostics';

export function remoteConversationJournal(recovery: RemoteConversationStore, epoch: string, draft: boolean): HarnessConversationJournal {
    return {epoch, load: async () => {
        const record = await recovery.load();
        if (draft && record?.submittedTurnId && !record.pending) { await recovery.save({}); return undefined; }
        return record;
    }, save: record => recovery.save({...record, submittedTurnId: recovery.submittedTurnId})};
}

/** A native create is provisional until the first turn has a committed receipt. */
export function draftHarness(client: HarnessClient, recovery: RemoteConversationStore): HarnessClient {
    return new Proxy(client, {get: (target, key) => {
        if (key === 'turn') return async (...args: Parameters<HarnessClient['turn']>) => {
            const result = await target.turn(...args);
            await recovery.submitted(result.turnId); return result;
        };
        if (key === 'operation') return async (...args: Parameters<HarnessClient['operation']>) => {
            const receipt: HarnessReceipt = await target.operation(...args);
            const result = receipt.result as {turnId?: unknown} | undefined;
            if (receipt.outcome === 'committed' && typeof result?.turnId === 'string') await recovery.submitted(result.turnId);
            return receipt;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    }});
}

/** Hide provisional identities from navigation without changing native ownership. */
export function draftConversation(source: HarnessConversationPort, recovery: RemoteConversationStore): HarnessConversationPort {
    const snapshot = (): HarnessConversationSnapshot => {
        const state = source.snapshot(), submittedTurnId = state.submittedTurnId ?? recovery.submittedTurnId;
        return {...state, submittedTurnId, sessionId: submittedTurnId ? state.sessionId : undefined,
            title: submittedTurnId ? state.title : t('harness.create')};
    };
    return new Proxy(source, {get: (target, key) => {
        if (key === 'snapshot') return snapshot;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? async (...args: unknown[]) => {
            const submitted = !!recovery.submittedTurnId;
            const result = await Reflect.apply(value, target, args);
            if (!submitted && (key === 'send' || key === 'reconcile') && snapshot().submittedTurnId && source.snapshot().canRename && source.rename) {
                try { await source.rename(formatDefaultFileTitle()); }
                catch (error) { reportRemoteFailure(error, {stage: 'draft.rename', sessionId: source.snapshot().sessionId}); }
            }
            return result && typeof result === 'object' && 'messages' in result ? snapshot() : result;
        } : value;
    }});
}
