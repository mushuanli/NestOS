import {afterEach, expect, it, vi} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/application';
import {HttpViewClient} from '@itookit/app-transport/http';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(releases.splice(0).map(release => release()));
    vi.useRealTimers(); vi.restoreAllMocks();
});

async function connection(mode: 'eof' | 'headers' | 'open') {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = new RpcPeer('server', async () => ({})), bootstrap = await server.bootstrap({title: 'Test'});
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [], commands: string[] = [];
    let subscriptions = 0;
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method) {
            const {kind} = JSON.parse(String(init.body)); commands.push(kind);
            return Response.json(kind === 'bootstrap' ? bootstrap : {});
        }
        if (++subscriptions > 1 && mode === 'headers') throw new TypeError('fetch failed');
        const body = new ReadableStream<Uint8Array>({start(controller) {
            streams.push(controller);
            controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            if (subscriptions > 1 && mode === 'eof') controller.close();
        }});
        return new Response(body, {headers: {'X-MindOS-View-Resume': '1'}});
    };
    const client = new HttpViewClient('test', '/api/application', fetcher);
    releases.push(async () => {await client.close(); await server.close();});
    await client.start();
    return {client, commands, disconnect: () => streams.at(-1)!.close(), subscriptions: () => subscriptions};
}

it.each(['eof', 'headers'] as const)('backs off repeated %s failures up to 15 seconds without replaying bootstrap', async mode => {
    const current = await connection(mode);
    current.disconnect(); await vi.advanceTimersByTimeAsync(0);
    expect(current.subscriptions()).toBe(2);
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
        const before = current.subscriptions();
        await vi.advanceTimersByTimeAsync(delay - 1); expect(current.subscriptions()).toBe(before);
        await vi.advanceTimersByTimeAsync(1); expect(current.subscriptions()).toBe(before + 1);
    }
    expect(current.commands).toEqual(['bootstrap']);
});

it('resets backoff after a stable stream instead of after successful headers', async () => {
    const current = await connection('open');
    current.disconnect(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(2);
    current.disconnect(); await vi.advanceTimersByTimeAsync(1000); expect(current.subscriptions()).toBe(3);
    await vi.advanceTimersByTimeAsync(15000);
    current.disconnect(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(4);
    current.disconnect(); await vi.advanceTimersByTimeAsync(999); expect(current.subscriptions()).toBe(4);
    await vi.advanceTimersByTimeAsync(1); expect(current.subscriptions()).toBe(5);
});

it('wakes backoff on explicit retry and stops all further subscriptions on close', async () => {
    const current = await connection('eof');
    current.disconnect(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(2);
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(3);
    await current.client.close();
    await vi.advanceTimersByTimeAsync(60000); expect(current.subscriptions()).toBe(3);
});

it('replaces a stale stream immediately on foreground wake without replaying bootstrap', async () => {
    const current = await connection('open');
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(1);
    vi.setSystemTime(Date.now() + 5 * 60000);
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0);
    expect(current.subscriptions()).toBe(2); expect(current.commands).toEqual(['bootstrap']);
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(2);
});
