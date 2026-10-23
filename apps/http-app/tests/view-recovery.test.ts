import {expect, it, vi} from 'vitest';
import {ViewRecovery} from '../src/client/view-recovery';

function view() {
    return {captureRecovery: vi.fn(() => ({text: 'Unsent draft', attachments: ['local-file']})),
        suspendForRecovery: vi.fn(), destroy: vi.fn(async () => {})};
}

it('recreates one view with the same local checkpoint and coalesces concurrent recovery', async () => {
    const previous = view(), next = view(), open = vi.fn(async () => next);
    const recovery = new ViewRecovery(previous, open);
    const one = recovery.recover(), two = recovery.recover(); expect(one).toBe(two);
    await one;
    expect(open).toHaveBeenCalledExactlyOnceWith({text: 'Unsent draft', attachments: ['local-file']});
    expect(previous.suspendForRecovery).toHaveBeenCalledOnce(); expect(previous.destroy).toHaveBeenCalledOnce();
    expect(recovery.current).toBe(next);
    await recovery.close(); expect(next.destroy).toHaveBeenCalledOnce();
});

it('retains the original view if its editor cannot safely checkpoint its input', async () => {
    const previous = view(), open = vi.fn();
    previous.captureRecovery.mockImplementation(() => {throw Object.assign(new Error('Unsaved settings'), {code: 'RECOVERY_SETTINGS_FORM'});});
    const recovery = new ViewRecovery(previous, open);
    await expect(recovery.recover()).rejects.toMatchObject({code: 'RECOVERY_SETTINGS_FORM'});
    expect(previous.destroy).not.toHaveBeenCalled(); expect(previous.suspendForRecovery).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});

it('keeps the checkpoint across failed reopening and never recaptures a disposed editor', async () => {
    const previous = view(), next = view(), open = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(next);
    const recovery = new ViewRecovery(previous, open);
    await expect(recovery.recover()).rejects.toThrow('Offline');
    await recovery.recover();
    expect(previous.captureRecovery).toHaveBeenCalledOnce(); expect(previous.destroy).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0]).toBe(open.mock.calls[1][0]); expect(recovery.current).toBe(next);
    await recovery.close();
});

it('logs safe error categories without exposing an arbitrary remote error code', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}), previous = view();
    const recovery = new ViewRecovery(previous, async () => {throw Object.assign(new Error('failed'), {code: 'private input must not be logged'});});
    try {
        await expect(recovery.recover()).rejects.toThrow('failed');
        expect(warning).toHaveBeenCalledWith('http.view.recovery', expect.objectContaining({stage: 'open', outcome: 'failure', code: 'RECOVERY_FAILED'}));
    } finally {warning.mockRestore(); await recovery.close();}
});
