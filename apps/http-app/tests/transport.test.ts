import { expect, it, vi } from 'vitest';
import { HttpTransport } from '../src/client/transport';
import { onStorageConnectionChange, setStorageAvailable } from '../src/client/connection-state';

it('includes the public request ID in a conflict without replaying the commit', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'ECONFLICT', message: 'changed' } }),
        { status: 409, headers: { 'X-Request-ID': id } }));
    await expect(new HttpTransport('/api/vfs', fetcher).call('records.commit', []))
        .rejects.toMatchObject({ code: 'ECONFLICT', message: expect.stringContaining(`requestId=${id}`) });
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reports a lost storage connection without replaying a write, then clears it on success', async () => {
    setStorageAvailable(true);
    const statuses: boolean[] = [], cause = new TypeError('Failed to fetch');
    const off = onStorageConnectionChange(value => statuses.push(value));
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(cause)
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'ok' })));
    try {
        const transport = new HttpTransport('/api/vfs', fetcher);
        await expect(transport.call('write', ['/file', 'bytes'])).rejects.toMatchObject({ code: 'EIO', cause });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(await transport.call('stat', ['/'])).toBe('ok');
        expect(statuses).toEqual([true, false, true]);
    } finally { off(); setStorageAvailable(true); }
});

it('does not label caller cancellation as a server outage', async () => {
    setStorageAvailable(true);
    const controller = new AbortController(); controller.abort();
    const error = new DOMException('Aborted', 'AbortError');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error), statuses: boolean[] = [];
    const off = onStorageConnectionChange(value => statuses.push(value));
    try {
        await expect(new HttpTransport('/api/vfs', fetcher).call('read', ['/'], controller.signal)).rejects.toBe(error);
        expect(statuses).toEqual([true]);
    } finally { off(); }
});
