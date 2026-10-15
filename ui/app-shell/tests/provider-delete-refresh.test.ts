// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigurationDeletionDialog } from '../src/configuration/delete-dialog';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
it('closes a committed deletion while its navigation refresh is still pending', async () => {
    let finish!: () => void;
    const refresh = new Promise<void>(resolve => { finish = resolve; }), changed = vi.fn(() => refresh);
    const commands = { inspectProviderDeletion: vi.fn(async () => ({ revision: 'reviewed',
        providers: [{ id: 'one', name: 'One' }], connections: [] })), deleteProviders: vi.fn(async () => {}), discardPlan: vi.fn() };
    const dialog = new ConfigurationDeletionDialog(commands as never, changed);
    try {
        const result = dialog.requestResult([{ kind: 'entity', entityType: 'provider', id: 'one' }]);
        await vi.waitFor(() => expect(document.querySelector('.settings-modal-confirm')).not.toBeNull());
        document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
        expect(await result).toBe('completed'); expect(commands.deleteProviders).toHaveBeenCalledWith({ revision: 'reviewed' });
        await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull());
        expect(changed).toHaveBeenCalledOnce();
    } finally { finish(); await refresh; }
});
