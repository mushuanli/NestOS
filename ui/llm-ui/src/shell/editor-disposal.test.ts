import { expect, it, vi } from 'vitest';
import { disposeEditorResources } from './editor-disposal';

it('releases all resources in order when saving and a subscription cleanup fail', async () => {
    const order: string[] = [];
    const cleanup = vi.fn(() => { order.push('cleanup'); });
    const failures = [new Error('save failed'), new Error('unsubscribe failed')];
    await expect(disposeEditorResources([
        async () => { order.push('save'); throw failures[0]; },
        async () => { order.push('detach'); },
        () => { order.push('unsubscribe'); throw failures[1]; }, cleanup,
    ])).rejects.toMatchObject({ errors: failures });
    expect(order).toEqual(['save', 'detach', 'unsubscribe', 'cleanup']);
    expect(cleanup).toHaveBeenCalledOnce();
});
