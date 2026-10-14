import { it, expect } from 'vitest';
import { HttpSyncClient } from '../src';
import { sha256 } from '@itookit/vfs-sync';
const command = { target: 'projects/p/datasets/files/publish', body: { authorityId: 'a', historyEpoch: 'e', operationId: 'op', replicaId: 'r', opSeq: '1' } };
it('retains durable rejection receipt on HTTP 412 and supplies epoch', async () => {
    const client = new HttpSyncClient({ endpoint: 'http://localhost', credential: () => 'secret', fetch: async (_, init) => {
        expect(new Headers(init?.headers).get('x-sync-history-epoch')).toBe('e');
        return Response.json({ operation: command.body, outcome: 'not-committed', code: 'HEAD_CONFLICT' }, { status: 412 });
    } }, 'e');
    expect((await client.execute(command)).code).toBe('HEAD_CONFLICT');
});
it('does not collapse OPERATION_EXPIRED to an ordinary missing file', async () => {
    const client = new HttpSyncClient({ endpoint: 'http://localhost', credential: () => 's', fetch: async () =>
        Response.json({ code: 'OPERATION_EXPIRED', outcome: 'not-committed' }, { status: 410 }) }, 'e');
    await expect(client.operation('r', '1')).rejects.toMatchObject({ code: 'OPERATION_EXPIRED', status: 410 });
});
it('verifies complete download bytes rather than trusting ETag', async () => {
    const client = new HttpSyncClient({ endpoint: 'http://localhost', credential: () => 's', fetch: async () => new Response('wrong') }, 'e');
    await expect(client.download('p', await sha256(new TextEncoder().encode('right')))).rejects.toThrow('OBJECT_HASH_MISMATCH');
});
it('sends raw upload bytes with binary content type and no invented command identity', async () => {
    const bytes = new TextEncoder().encode('raw');
    const client = new HttpSyncClient({ endpoint: 'http://localhost', credential: () => 's', fetch: async (_, init) => {
        expect(new Headers(init?.headers).get('content-type')).toBe('application/octet-stream');
        expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(bytes); return Response.json({ ready: true });
    } }, 'e');
    expect(await client.upload('p', bytes)).toBe(await sha256(bytes));
});
