import { expect, it, vi } from 'vitest';
import { HttpApplicationPort } from '../src/client/application-port';
import { ApplicationEventStream, type EventSourceFactory } from '../src/client/application-event-stream';

it('never replays an ambiguous mutation and retains the caller request identity on the wire', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Response lost'));
    const port = new HttpApplicationPort('/api/application', fetcher, 'client');
    await expect(port.command('createConversation', { title: 'Once' }, undefined, 'request')).rejects.toThrow('lost');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ clientId: 'client', requestId: 'request', kind: 'command' });
});
it('rejects a cancelled request before transmitting it', async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn<typeof fetch>();
    const port = new HttpApplicationPort('/api/application', fetcher, 'client');
    await expect(port.query('sessions', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
});
it('avoids an initial redundant refresh and invalidates observation after event reconnection', () => {
    const connection: ReturnType<EventSourceFactory> = { onmessage: null, onerror: null, onopen: null, close: vi.fn() };
    const publish = vi.fn(), stream = new ApplicationEventStream('/api/application', 'client', publish, () => connection);
    stream.start(); connection.onopen!(new Event('open')); expect(publish).not.toHaveBeenCalled();
    connection.onerror!(new Event('error')); connection.onopen!(new Event('open'));
    expect(publish).toHaveBeenCalledTimes(2); expect(publish).toHaveBeenLastCalledWith({ kind: 'invalidate', scope: 'all', revision: 0 });
    stream.close(); expect(connection.close).toHaveBeenCalledOnce();
});
