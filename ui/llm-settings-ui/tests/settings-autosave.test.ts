// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsAutoSave } from '@itookit/ui-common';

const controllers: SettingsAutoSave[] = [];
afterEach(async () => {
    await Promise.all(controllers.splice(0).map(controller => controller.dispose(false)));
    vi.useRealTimers(); document.body.innerHTML = '';
});
function setup(save: () => Promise<void | false>, markup = '<input name="name" value="original">') {
    document.body.innerHTML = `<form>${markup}</form>`;
    const root = document.querySelector('form')!;
    const controller = new SettingsAutoSave(root, save); controllers.push(controller);
    return { root, controller, field: root.querySelector<HTMLInputElement>('input')! };
}

it('debounces text and saves discrete changes without replacing the focused input', async () => {
    vi.useFakeTimers(); const save = vi.fn().mockResolvedValue(undefined);
    const { root, field } = setup(save);
    field.focus(); field.value = 'one'; field.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    field.value = 'two'; field.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(599); expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(save).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(field);
    expect(root.querySelector('[data-autosave-status]')?.getAttribute('data-state')).toBe('saved');
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0); expect(save).toHaveBeenCalledTimes(2);
});

it('serializes writes and preserves a newer edit while the previous save is pending', async () => {
    let finish!: () => void; const snapshots: string[] = [];
    const { field, controller } = setup(async () => {
        snapshots.push(field.value);
        if (snapshots.length === 1) await new Promise<void>(resolve => { finish = resolve; });
    });
    field.value = 'first'; controller.request(); const flushing = controller.flush();
    field.value = 'second'; controller.request(); expect(snapshots).toEqual(['first']);
    finish(); await flushing; expect(snapshots).toEqual(['first', 'second']);
    expect(controller.isDirty).toBe(false);
});

it('retains invalid and failed drafts, exposes retry and refuses a lossy disposal', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk offline')).mockResolvedValue(undefined);
    const { root, field, controller } = setup(save, '<input name="name" required value="original">');
    field.value = ''; controller.request(); expect(await controller.dispose()).toBe(false);
    expect(save).not.toHaveBeenCalled(); expect(field.isConnected).toBe(true);
    field.value = 'valid'; controller.request(); expect(await controller.flush()).toBe(false);
    expect(root.querySelector('[data-autosave-status]')?.textContent).toContain('disk offline');
    expect(controller.isDirty).toBe(true);
    const retry = root.querySelector<HTMLButtonElement>('button')!; expect(retry.hidden).toBe(false); retry.click();
    await vi.waitFor(() => expect(controller.isDirty).toBe(false));
    expect(await controller.dispose()).toBe(true);
});

it('defers credentials until blur and does not save unfinished IME composition', async () => {
    vi.useFakeTimers(); const save = vi.fn().mockResolvedValue(undefined);
    const { field } = setup(save, '<input type="password" name="apiKey">');
    field.value = 'secret'; field.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(2000); expect(save).not.toHaveBeenCalled();
    field.dispatchEvent(new Event('focusout', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0); expect(save).toHaveBeenCalledOnce();
    field.type = 'text'; field.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(2000); expect(save).toHaveBeenCalledOnce();
    field.dispatchEvent(new Event('compositionend', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600); expect(save).toHaveBeenCalledTimes(2);
});
