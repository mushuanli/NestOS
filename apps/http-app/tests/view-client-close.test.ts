import {afterEach, expect, it, vi} from 'vitest';
import {RpcPeer} from '@itookit/app-transport/application';
import {HttpViewClient} from '@itookit/app-transport/http';
import type {Call} from '@itookit/app-transport/rpc';

type Request = {kind: string; call?: Call; calls?: Call[]};
const releases: Array<() => Promise<void>> = [];
afterEach(async () => {
    try {await Promise.all(releases.splice(0).map(release => release()));}
    finally {vi.useRealTimers();}
});

async function connection(before: (request: Request, signal: AbortSignal) => Promise<void>) {
    const workbenchView = vi.fn(async () => undefined), stopped = vi.fn(), cancelled = vi.fn();
    const server = new RpcPeer('server', async () => ({}));
    const bootstrap = await server.bootstrap({backend: {workbenchView, toolboxView: async () => {}, taskDetails: async () => {}},
        files: {getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {}, onAny: () => stopped}});
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
        if (!init?.method) return new Response(new ReadableStream({cancel: cancelled}));
        const request = JSON.parse(String(init.body)) as Request; requests.push(request);
        await before(request, init.signal!);
        const reply = request.kind === 'bootstrap' ? bootstrap : request.kind === 'call' ? await server.handle(request.call!)
            : request.calls ? {replies: await Promise.all(request.calls.map(call => server.handle(call)))} : {};
        return Response.json(reply);
    };
    const client = new HttpViewClient('test', '/api/application', fetcher);
    releases.push(async () => {await client.close(); await server.close();});
    const root = await client.start() as any;
    return {client, server, root, requests, workbenchView, stopped, cancelled};
}

function stalled(signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
}

it('aborts a stalled RPC and finishes closing within five seconds without replaying it', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    const f = await connection(async (request, next) => {if (request.kind === 'call') {signal = next; await stalled(next);}});
    const result = f.root.backend.workbenchView().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0); expect(signal).toBeDefined();
    const closed = f.client.close(); expect(f.client.close()).toBe(closed);
    await vi.advanceTimersByTimeAsync(4999); expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await closed;
    expect(signal.aborted).toBe(true); expect(await result).toMatchObject({name: 'AbortError'});
    expect(f.requests.filter(request => request.kind === 'call')).toHaveLength(1);
    expect(f.requests.some(request => request.kind === 'close')).toBe(false);
    expect(f.workbenchView).not.toHaveBeenCalled(); expect(f.cancelled).toHaveBeenCalledOnce();
});

it('also bounds the close request itself and releases local resources when it stalls', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    const f = await connection(async (request, next) => {if (request.kind === 'close') {signal = next; await stalled(next);}});
    const closed = f.client.close(); await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false); await vi.advanceTimersByTimeAsync(5000); await closed;
    expect(signal.aborted).toBe(true); expect(f.cancelled).toHaveBeenCalledOnce();
    await expect(f.root.backend.workbenchView()).rejects.toMatchObject({code: 'EIO'});
});

it('waits for an asynchronous unsubscribe before sending a single close request', async () => {
    let release!: () => void, block = false;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const f = await connection(async request => {if (block && request.kind === 'call') await gate;});
    const stop = f.root.files.onAny(() => {}); await f.client.peer.whenIdle();
    block = true; stop(); const closed = f.client.close();
    await vi.waitFor(() => expect(f.requests.some(request => request.kind === 'call')).toBe(true));
    expect(f.requests.some(request => request.kind === 'close')).toBe(false); expect(f.stopped).not.toHaveBeenCalled();
    release(); await closed; await f.client.close();
    expect(f.stopped).toHaveBeenCalledOnce(); expect(f.cancelled).toHaveBeenCalledOnce();
    expect(f.requests.filter(request => request.kind === 'close')).toHaveLength(1);
});
