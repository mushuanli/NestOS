// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
import type { ConnectionOption } from '../../llm-ui/src/domain/types';

afterEach(() => { document.body.replaceChildren(); });
const option = (id: string): ConnectionOption => ({ id, name: id, provider: 'p', hasApiKey: true, hasTiers: false, tiers: {} });

it('refreshes an already open connection popup while preserving its search', async () => {
    let connections = [option('First')];
    const request = vi.fn(async () => connections);
    const host = document.createElement('div'); document.body.append(host);
    const view = new ChatInput(host, { onRequestConnections: request } as never);
    try {
        await view.refreshConnections(); view.openConnectionPicker();
        await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('First'));
        const search = document.querySelector<HTMLInputElement>('.llm-popup--visible input')!;
        search.value = 'New'; search.dispatchEvent(new Event('input', { bubbles: true }));
        connections = [option('First'), option('New connection')];
        await view.refreshConnections();
        expect(search.value).toBe('New');
        expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('New connection');
        expect(document.querySelector('.llm-popup--visible')?.textContent).not.toContain('First');
        expect(request.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally { view.destroy(); }
});

it('rejects stale overlapping connection loads', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const pending: Array<(options: ConnectionOption[]) => void> = [];
    const request = vi.fn(() => new Promise<ConnectionOption[]>(resolve => { pending.push(resolve); }));
    const view = new ChatInput(host, { onRequestConnections: request } as never);
    try {
        const refreshed = view.refreshConnections(); pending[1]([option('Newest')]); await refreshed;
        pending[0]([option('Stale')]); await Promise.resolve();
        const select = host.querySelector<HTMLSelectElement>('.llm-input__connection-select')!;
        expect(select.textContent).toContain('Newest'); expect(select.textContent).not.toContain('Stale');
    } finally { view.destroy(); }
});
