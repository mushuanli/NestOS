// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { installWindowClose } from '../../../apps/tauri-app/src/shell/window-lifecycle';

it('prevents repeated close requests until application cleanup releases its leases', async () => {
    let listener!: (event: { preventDefault(): void }) => void | Promise<void>;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const unlisten = vi.fn();
    const window = { onCloseRequested: vi.fn(async handler => { listener = handler; return unlisten; }), destroy: vi.fn(async () => {}) };
    const app = { destroy: vi.fn(() => pending) };
    await installWindowClose(window, app);
    const event = { preventDefault: vi.fn() };
    const first = listener(event), second = listener(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(app.destroy).toHaveBeenCalledTimes(1);
    expect(window.destroy).not.toHaveBeenCalled();
    expect(unlisten).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
});
