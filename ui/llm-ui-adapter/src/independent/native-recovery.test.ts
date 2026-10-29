// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createOperationLedger, type ChatView} from '@itookit/llm-ui';
import {mountNativeRecovery} from './native-recovery';
it('queries the original legacy operation from another scope without resubmitting or consuming new input', async () => {
    const operations = createOperationLedger({initial: [{context: {operationId: 'original', viewId: 'old'}, conversationId: 'native',
        kind: 'send', input: {protocol: 'legacy-composer-v1'}, status: 'unknown', draft: {scopeId: 'old-scope', revision: 1, textRevision: 1, text: 'Old', attachments: []}}]});
    const draft = {scopeId: 'new-scope', revision: 3, textRevision: 2, text: 'New input', attachments: []};
    const receipt = vi.fn(async (id: string) => ({status: 'accepted' as const, operationId: id})), error = vi.fn();
    const root = document.createElement('div'); document.body.append(root);
    const recovery = mountNativeRecovery(root, operations, () => ({getDraft: () => draft}) as unknown as ChatView, () => true, receipt, error);
    root.querySelector('button')!.click(); await vi.waitFor(() => expect(operations.getSnapshot()[0].status).toBe('accepted'));
    expect(receipt).toHaveBeenCalledWith('original'); expect(draft.text).toBe('New input'); expect(root.querySelector('button')).toBeNull();
    recovery.destroy(); root.remove(); expect(error).not.toHaveBeenCalled();
});
