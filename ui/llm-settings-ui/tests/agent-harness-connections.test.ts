// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editHarnessConnection } from '../src/editors/agent-harness-connections';
import type { HarnessConnectionManagement } from '../src/editors/agent-execution-options';

const target = { nodeConnectionId: 'node', projectId: 'project', projectName: '<img src=x>',
    available: true, profiles: [{ id: 'claude', kind: 'claude', name: 'Claude' }] };
function fixture(): HarnessConnectionManagement {
    return { targets: vi.fn(async () => [target]), get: vi.fn(async () => undefined),
        save: vi.fn(async connection => ({ version: 1, revision: 1, connection })) };
}
function fields() {
    return { name: document.querySelector<HTMLInputElement>('[name=harnessName]')!,
        target: document.querySelector<HTMLSelectElement>('[name=harnessTarget]')!,
        confirm: document.querySelector<HTMLButtonElement>('.settings-modal-confirm')! };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('creates only an authorized target and retries with the same identity and expected revision', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const port = fixture(), saved = vi.fn();
    vi.mocked(port.save).mockRejectedValueOnce(new Error('secret endpoint'));
    await editHarnessConnection(port, undefined, saved);
    expect(document.querySelector('.settings-modal__body img')).toBeNull();
    const f = fields(); f.name.value = 'Reviewer'; f.target.value = '0'; f.confirm.click();
    await vi.waitFor(() => expect(port.save).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.confirm.disabled).toBe(false));
    expect(document.body.textContent).not.toContain('secret endpoint'); expect(saved).not.toHaveBeenCalled();
    f.confirm.click(); await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    const calls = vi.mocked(port.save).mock.calls;
    expect(calls[0][0]).toEqual(calls[1][0]); expect(calls.map(call => call[1])).toEqual([0, 0]);
    expect(calls[0][0]).toMatchObject({ name: 'Reviewer', nodeConnectionId: 'node', projectId: 'project', profileId: 'claude' });
});

it('preserves unshown model selection and saves with the current revision', async () => {
    const port = fixture();
    vi.mocked(port.get).mockResolvedValue({ version: 1, revision: 7, connection: { id: 'remote', kind: 'harness',
        name: 'Reviewer', nodeConnectionId: 'node', projectId: 'project', profileId: 'claude',
        selection: { modelId: 'remote-model', reasoningEffort: 'native' } } });
    await editHarnessConnection(port, 'remote', vi.fn()); fields().confirm.click();
    await vi.waitFor(() => expect(port.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(port.save).mock.calls[0]).toEqual([expect.objectContaining({ id: 'remote',
        selection: { modelId: 'remote-model', reasoningEffort: 'native' } }), 7]);
});

it('does not create a dialog after its owning editor has been disposed', async () => {
    const port = fixture(); await editHarnessConnection(port, undefined, vi.fn(), () => false);
    expect(document.querySelector('.settings-modal-overlay')).toBeNull();
});

it('does not submit when no authorized execution target is available', async () => {
    const port = fixture(); vi.mocked(port.targets).mockResolvedValue([{ ...target, available: false }]);
    await editHarnessConnection(port, undefined, vi.fn()); fields().name.value = 'Reviewer'; fields().confirm.click();
    await vi.waitFor(() => expect(fields().confirm.disabled).toBe(false)); expect(port.save).not.toHaveBeenCalled();
});
