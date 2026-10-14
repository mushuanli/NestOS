// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { openTaskTranscript } from '../../llm-ui/src/components/dag/TaskTranscriptDialog';

beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
});
afterEach(() => { document.body.replaceChildren(); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Microtask flush: the dialog chains a command result into the download. */
const flush = async (): Promise<void> => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

it('renders exchanges as text and exports the complete transcript', async () => {
    vi.useFakeTimers();
    const transcript = { sessionId: 's', runTaskId: 'root', taskId: 'task/1', nodeId: 'agent', status: 'succeeded', version: 4,
        input: '<img src=x onerror=alert(1)>', output: 'done', interactions: {},
        effects: [{ effectId: 'first', status: 'succeeded', request: { kind: 'llm.chat' }, result: 'early response' }] };
    const execute = vi.fn(async () => transcript);
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:transcript'), revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe('transcript-task_1.json');
    });
    openTaskTranscript({ execute } as never, 's', 'root', 'task/1');
    await flush();
    const dialog = document.querySelector('dialog')!;
    // Interactive pages are byte-budgeted, so a huge transcript cannot pin the dialog.
    expect(execute).toHaveBeenCalledWith('dag.run.transcript', { sessionId: 's', taskId: 'root', targetTaskId: 'task/1',
        query: { maxBytes: 262144 } });
    expect(dialog.querySelector('pre')!.textContent).toContain(transcript.input);
    expect(dialog.querySelector('pre')!.textContent).toContain('early response');
    expect(dialog.querySelector('img')).toBeNull();
    dialog.querySelector<HTMLButtonElement>('[data-export]')!.click();
    await flush();
    expect(click).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json;charset=utf-8');
    expect(blob.size).toBe(new Blob([JSON.stringify(transcript, null, 2)]).size);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:transcript');
});

it('discards a late response after the transcript dialog is closed', async () => {
    let resolve!: (value: unknown) => void;
    const execute = vi.fn(() => new Promise(done => { resolve = done; }));
    openTaskTranscript({ execute } as never, 's', 'root', 'task');
    const dialog = document.querySelector('dialog')!;
    dialog.dispatchEvent(new Event('close'));
    resolve({ effects: [] });
    await flush();
    expect(document.querySelector('dialog')).toBeNull();
    expect(dialog.querySelector<HTMLButtonElement>('[data-export]')!.disabled).toBe(true);
});

it('pages within the byte budget and marks a truncated page', async () => {
    const base = { sessionId: 's', runTaskId: 'root', taskId: 'task', nodeId: 'agent', status: 'succeeded', version: 7,
        input: 'input', output: 'output', interactions: {}, totalEffects: 2 };
    const effect = (effectId: string) => ({ effectId, status: 'succeeded', request: { kind: 'llm.chat' } });
    const execute = vi.fn(async (_command: string, payload: { query?: { offset?: number } }) => (payload.query?.offset ?? 0) === 0
        ? { ...base, effects: [effect('first')], nextOffset: 1, truncated: true, bytes: 2048 }
        : { ...base, effects: [effect('second')], bytes: 512 });
    openTaskTranscript({ execute } as never, 's', 'root', 'task');
    await flush();
    const dialog = document.querySelector('dialog')!;
    const status = dialog.querySelector('[data-status]')!.textContent!;
    expect(status).toContain('v7');
    expect(status).toContain(t('flow.transcript.truncated'));
    expect(dialog.querySelector<HTMLButtonElement>('[data-more]')!.hidden).toBe(false);
    dialog.querySelector<HTMLButtonElement>('[data-more]')!.click();
    await flush();
    // The next page pins the version read from the first page and keeps the budget.
    expect(execute).toHaveBeenLastCalledWith('dag.run.transcript', { sessionId: 's', taskId: 'root', targetTaskId: 'task',
        query: { version: 7, offset: 1, maxBytes: 262144 } });
    expect(dialog.querySelector('pre')!.textContent).toContain('first');
    expect(dialog.querySelector('pre')!.textContent).toContain('second');
    expect(dialog.querySelector<HTMLButtonElement>('[data-more]')!.hidden).toBe(true);
});

it('exports every page of the reviewed version even when only the first page is visible', async () => {
    vi.useFakeTimers();
    let content = '', mime = '';
    const NativeBlob = Blob;
    vi.stubGlobal('Blob', class extends NativeBlob {
        constructor(parts: BlobPart[], options: BlobPropertyBag) {
            super(parts, options); content = parts.join(''); mime = options.type ?? '';
        }
    });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:text'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe('transcript-task_1.txt');
    });
    const base = { sessionId: 'session', runTaskId: 'root', taskId: 'task/1', nodeId: 'agent', status: 'succeeded', version: 7,
        input: 'original input', output: 'final answer', interactions: { choice: 'accepted' }, totalEffects: 2 };
    const effect = (id: string) => ({ effectId: id, status: 'succeeded', request: { kind: 'llm.chat' }, result: id });
    const execute = vi.fn(async (_command: string, payload: { query?: { offset?: number } }) => (payload.query?.offset ?? 0) === 0
        ? { ...base, effects: [effect('first exchange')], nextOffset: 1, bytes: 1024 }
        : { ...base, effects: [effect('second exchange')], bytes: 1024 });
    openTaskTranscript({ execute } as never, 'session', 'root', 'task/1');
    await flush();
    const button = document.querySelector<HTMLButtonElement>('[data-export-text]')!;
    expect(button.disabled).toBe(false);
    button.click();
    await flush();
    expect(mime).toBe('text/plain;charset=utf-8');
    for (const value of ['session', 'root', 'task/1', '"version": 7', 'first exchange', 'second exchange', 'original input', 'final answer', 'accepted']) {
        expect(content).toContain(value);
    }
    expect(click).toHaveBeenCalledOnce();
    vi.runAllTimers();
});

it.each([
    { name: 'a final page above the export limit', change: { effects: Array.from({ length: 10001 }, (_, id) => ({ effectId: String(id) })) } },
    { name: 'a different version', change: { version: 8 } },
    { name: 'a different task', change: { taskId: 'other' } },
    { name: 'a truncated export', change: { truncated: true } },
    { name: 'a non-finite cursor', change: { nextOffset: NaN } },
])('refuses to download $name as a complete transcript', async ({ change }) => {
    const base = { sessionId: 's', runTaskId: 'root', taskId: 'task', status: 'succeeded', version: 7,
        input: '', output: '', interactions: {}, effects: [{ effectId: 'first', request: { kind: 'llm.chat' } }] };
    const execute = vi.fn().mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, ...change }).mockResolvedValue(base);
    const createObjectURL = vi.fn(() => 'blob:invalid');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    openTaskTranscript({ execute } as never, 's', 'root', 'task'); await flush();
    document.querySelector<HTMLButtonElement>('[data-export]')!.click(); await flush();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector('[data-status]')!.textContent).toBe(t('flow.transcript.failed'));
    expect(execute).toHaveBeenCalledTimes(2);
});

it('keeps the truncation warning when a later visible page is complete', async () => {
    const base = { sessionId: 's', runTaskId: 'root', taskId: 'task', status: 'succeeded', version: 7,
        input: '', output: '', interactions: {}, effects: [{ effectId: 'first', request: { kind: 'llm.chat' } }] };
    const execute = vi.fn().mockResolvedValueOnce({ ...base, nextOffset: 1, truncated: true, bytes: 100 })
        .mockResolvedValueOnce({ ...base, effects: [{ effectId: 'second', request: { kind: 'llm.chat' } }], bytes: 50 });
    openTaskTranscript({ execute } as never, 's', 'root', 'task'); await flush();
    document.querySelector<HTMLButtonElement>('[data-more]')!.click(); await flush();
    expect(document.querySelector('[data-status]')!.textContent).toContain(t('flow.transcript.truncated'));
});

it('stops paging a closed export and locks paging while export is pending', async () => {
    const base = { sessionId: 's', runTaskId: 'root', taskId: 'task', status: 'succeeded', version: 7,
        input: '', output: '', interactions: {}, effects: [{ effectId: 'first', request: { kind: 'llm.chat' } }], nextOffset: 1 };
    let resolve!: (page: typeof base) => void;
    const execute = vi.fn().mockResolvedValueOnce(base).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const createObjectURL = vi.fn(); vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    openTaskTranscript({ execute } as never, 's', 'root', 'task'); await flush();
    const dialog = document.querySelector('dialog')!;
    dialog.querySelector<HTMLButtonElement>('[data-export]')!.click();
    expect(dialog.querySelector<HTMLButtonElement>('[data-more]')!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>('[data-export-text]')!.disabled).toBe(true);
    dialog.dispatchEvent(new Event('close')); resolve(base); await flush();
    expect(execute).toHaveBeenCalledTimes(2); expect(createObjectURL).not.toHaveBeenCalled();
});
