import { afterEach, expect, it, vi } from 'vitest';
import { RpcPeer } from '@itookit/app-transport/application';
import { HttpViewClient } from '@itookit/app-transport/http';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(releases.splice(0).map(release => release())); vi.restoreAllMocks(); });

async function connection(resumable = false, value: unknown = {title: 'Test'}) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = new RpcPeer('server', async () => ({}));
    const bootstrap = await server.bootstrap(value);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const fetcher: typeof fetch = async (_input, init) => {
        if (!init?.method) return new Response(body, {headers: resumable ? {'X-NestOS-View-Resume': '1'} : {}});
        const request = JSON.parse(String(init.body));
        return Response.json(request.kind === 'bootstrap' ? bootstrap : {});
    };
    const disconnected = vi.fn(), updateError = vi.fn();
    const client = new HttpViewClient('test', '/api/application', fetcher, disconnected, updateError);
    releases.push(async () => { await client.close(); await server.close(); });
    const root = await client.start();
    const frame = (text: string) => stream.enqueue(new TextEncoder().encode(text));
    const send = (text: string) => frame(`data: ${text}\n\n`);
    return { client, server, root, stream, send, frame, disconnected, updateError };
}

it('reports a snapshot application failure without declaring the HTTP connection lost', async () => {
    const { client, send, disconnected, updateError } = await connection();
    const error = new Error('Invalid snapshot');
    vi.spyOn(client.peer, 'applyUpdates').mockImplementationOnce(() => { throw error; });
    send('{}');
    await vi.waitFor(() => expect(updateError).toHaveBeenCalledExactlyOnceWith(error));
    expect(() => send('{}')).toThrow('Controller is already closed');
    expect(disconnected).not.toHaveBeenCalled(); expect(updateError).toHaveBeenCalledOnce();
});

it('reports malformed event data as an update failure', async () => {
    const { send, disconnected, updateError } = await connection();
    send('{invalid');
    await vi.waitFor(() => expect(updateError).toHaveBeenCalledWith(expect.any(SyntaxError)));
    expect(disconnected).not.toHaveBeenCalled();
});

it.each(['null', '42', '[]'])('reports an invalid event packet %s without misclassifying its processing error', async packet => {
    const { send, disconnected, updateError } = await connection();
    send(packet);
    await vi.waitFor(() => expect(updateError).toHaveBeenCalledWith(expect.objectContaining({code: 'EIO'})));
    expect(disconnected).not.toHaveBeenCalled();
});

it('still reports a failed event stream as a real disconnection', async () => {
    const { stream, disconnected, updateError } = await connection();
    const error = new TypeError('network stream failed'); stream.error(error);
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledExactlyOnceWith(error));
    expect(updateError).not.toHaveBeenCalled();
});

it('keeps notification backpressure bounded and reports its own cause', async () => {
    const { send, disconnected, updateError } = await connection();
    send(JSON.stringify({ calls: Array.from({ length: 257 }, () => ({ target: 'unused', method: 'call', args: [] })) }));
    await vi.waitFor(() => expect(updateError).toHaveBeenCalledWith(expect.objectContaining({ code: 'EBUSY' })));
    expect(disconnected).not.toHaveBeenCalled();
});

it('ignores repeated event frames and stops at a sequence gap', async () => {
    const {client, frame, disconnected, updateError} = await connection(true);
    const apply = vi.spyOn(client.peer, 'applyUpdates');
    frame('id: 1\ndata: {}\n\nid: 1\ndata: {}\n\n');
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    frame('id: 3\ndata: {}\n\n');
    await vi.waitFor(() => expect(updateError).toHaveBeenCalledWith(expect.objectContaining({code: 'EIO'})));
    expect(apply).toHaveBeenCalledOnce(); expect(disconnected).not.toHaveBeenCalled();
});

it('reports a notification callback failure instead of silently losing view changes', async () => {
    const {client, send, disconnected, updateError} = await connection();
    vi.spyOn(client.peer, 'handle').mockResolvedValueOnce({error: {name: 'Error', message: 'Application view event gap', code: 'EIO'}});
    send(JSON.stringify({calls: [{target: 'view', method: 'notify', args: []}]}));
    await vi.waitFor(() => expect(updateError).toHaveBeenCalledWith(expect.objectContaining({message: 'Application view event gap', code: 'EIO'})));
    expect(disconnected).not.toHaveBeenCalled();
});

it('drains healthy notifications between frames coalesced into one network read', async () => {
    const {client, frame, disconnected, updateError} = await connection();
    const apply = vi.spyOn(client.peer, 'applyUpdates');
    frame('data: {}\n\n'.repeat(300));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(300));
    expect(updateError).not.toHaveBeenCalled(); expect(disconnected).not.toHaveBeenCalled();
});

it('switches A to B and back to A with large legal Session snapshots', async () => {
    let changed = () => {}, snapshot = {sessionId: 'a', messages: [{id: 'message', content: 'a'.repeat(1100 * 1024)}]};
    const source = {getSnapshot: () => snapshot, getSessions: () => [],
        onGlobalEvent: (listener: () => void) => {changed = listener; return () => {changed = () => {};};}};
    const {server, root, send, updateError, disconnected} = await connection(false, source);
    const manager = root as unknown as typeof source;
    for (const [index, id] of ['b', 'a', 'b', 'a'].entries()) {
        snapshot = {sessionId: id, messages: [{id: 'message', content: id.repeat(1100 * 1024)}]}; changed();
        const packet = JSON.stringify({updates: await server.refresh()});
        expect(new TextEncoder().encode(packet).byteLength).toBeLessThan(2 * 1024 * 1024);
        if (index === 0) expect(packet.length).toBeGreaterThan(1024 * 1024);
        else expect(packet.length).toBeLessThan(2048);
        send(packet);
        await vi.waitFor(() => expect(manager.getSnapshot().sessionId).toBe(id));
        expect(manager.getSnapshot().messages[0].content).toBe(snapshot.messages[0].content);
    }
    expect(updateError).not.toHaveBeenCalled(); expect(disconnected).not.toHaveBeenCalled();
});

it('bounds a truly blocked callback while preserving the precise overload metadata', async () => {
    const {client, frame, disconnected, updateError} = await connection();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    vi.spyOn(client.peer, 'handle').mockImplementation(async () => {await blocked; return {};});
    try {
        const packet = JSON.stringify({calls: [{target: 'callback', method: 'call', args: ['PRIVATE_BODY']}]});
        frame(`data: ${packet}\n\n`.repeat(300));
        await vi.waitFor(() => expect(updateError).toHaveBeenCalledOnce());
        const error = updateError.mock.calls[0][0];
        expect(error).toMatchObject({code: 'EBUSY', reason: 'NOTIFICATION_COUNT_LIMIT', pendingNotifications: 256,
            incomingNotifications: 1, durationMs: expect.any(Number)});
        expect(JSON.stringify(error)).not.toContain('PRIVATE_BODY'); expect(disconnected).not.toHaveBeenCalled();
    } finally {release();}
});

it('drains multiple legal large frames in a single read without treating the whole read as one frame', async () => {
    const {client, frame, updateError} = await connection(), apply = vi.spyOn(client.peer, 'applyUpdates');
    frame(('data: ' + JSON.stringify({padding: 'x'.repeat(800 * 1024)}) + '\n\n').repeat(3));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(3)); expect(updateError).not.toHaveBeenCalled();
});

it('still rejects a wire frame larger than two MiB, including multibyte text', async () => {
    const {client, send, updateError} = await connection(), apply = vi.spyOn(client.peer, 'applyUpdates');
    send(JSON.stringify({padding: '字'.repeat(750 * 1024)}));
    await vi.waitFor(() => expect(updateError).toHaveBeenCalledWith(expect.objectContaining({code: 'EBUSY', message: expect.stringContaining('event is too large')})));
    expect(apply).not.toHaveBeenCalled();
});
