// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { DigitalTwinService } from '@itookit/app-core';
import { showTwinSource } from '../src/digital-twin/source-dialog';

it('preserves completed progress nodes through timer ticks and unchanged notifications', async () => {
    vi.useFakeTimers();
    const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
    let changed!: () => void;
    const info = { included: true, ignored: false, settings: { data: { connectionId: 'model', paused: false } },
        worker: { error: '' }, sources: [], memories: [], jobs: [], discoveryErrors: [], nextScanAt: 0,
        plan: { id: 'plan', revision: 'r', data: { kinds: [] } },
        runs: [{ id: 'run', data: { planId: 'plan', planRevision: 'r', state: 'succeeded', createdAt: 1, startedAt: 2, finishedAt: 3 } }] };
    const service = { onChange: (listener: () => void) => { changed = listener; return () => {}; },
        selectionInfo: vi.fn(async () => info) } as unknown as DigitalTwinService;
    const abort = new AbortController();
    try {
        showTwinSource(service, { kind: 'file', target: 'note', label: 'Note' }, vi.fn(), abort.signal);
        await vi.advanceTimersByTimeAsync(0);
        const progress = document.querySelector('[data-results] > div')!;
        const node = progress.firstElementChild;
        expect(node).not.toBeNull();
        await vi.advanceTimersByTimeAsync(3000);
        expect(progress.firstElementChild).toBe(node);
        changed(); await vi.advanceTimersByTimeAsync(0);
        expect(progress.firstElementChild).toBe(node);
    } finally {
        abort.abort();
        if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
        vi.useRealTimers(); document.body.replaceChildren();
    }
});
