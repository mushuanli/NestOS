import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, it, vi} from 'vitest';
import {NodeToolConnections} from '../src/runtime/tool-connections';
import {loadNodeToolModules} from '../src/runtime/tool-modules';

it('binds shared Google tool code to each user’s private connection and workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'google-users-'));
    const module = fileURLToPath(new URL('../../../tools/googlecli/node/extension.mjs', import.meta.url));
    const logs: string[] = [];
    const fetcher = vi.fn(async (url: string | URL, init: RequestInit) => {
        if (String(url).includes('oauth2')) return Response.json({access_token: new URLSearchParams(init.body as URLSearchParams).get('refresh_token')});
        const authorization = (init.headers as Record<string, string>).Authorization;
        const owner = authorization === 'Bearer alice-token' ? 'alice' : authorization === 'Bearer bob-token' ? 'bob' : 'invalid';
        expect(owner).not.toBe('invalid');
        if (new URL(url).pathname.endsWith('/messages')) return Response.json({messages: [{id: 'same-message-id'}]});
        return Response.json({id: 'same-message-id', payload: {mimeType: 'text/plain', body: {data: Buffer.from(owner + ' private message').toString('base64url')}}});
    });
    vi.stubGlobal('fetch', fetcher);
    const users = ['alice', 'bob'].map(name => ({name, connections: new NodeToolConnections(path.join(root, name), {fetcher: fetch}), files: new Map<string, string>()}));
    try {
        for (const user of users) {
            const tools = await loadNodeToolModules(JSON.stringify([module]), user.connections);
            await user.connections.save({id: 'personal', type: 'google-workspace', name: 'Personal', values: {
                clientId: 'client', clientSecret: user.name + '-secret', refreshToken: user.name + '-token'}});
            const tool = tools.find(tool => tool.name === 'google.collect')!;
            await tool.call(tool.inputSchema.parse({resource: 'mail', connection: 'personal', directory: 'imports/mail'}), {
                operationId: 'collect-' + user.name, onProgress: async (value: {message: string}) => {logs.push(value.message);},
                vfs: {readFile: async (file: string) => {
                    if (!user.files.has(file)) throw Object.assign(new Error('Missing'), {code: 'ENOENT'});
                    return user.files.get(file)!;
                }, writeFile: async (file: string, content: string) => {user.files.set(file, content);}, listFiles: async () => []},
            } as never);
        }
        expect([...users[0].files.values()].join('')).toContain('alice private message');
        expect([...users[0].files.keys()].some(file => file.startsWith('imports/mail/personal/mail/default/') && file.endsWith('.email'))).toBe(true);
        expect([...users[0].files.values()].join('')).not.toContain('bob private message');
        expect([...users[1].files.values()].join('')).toContain('bob private message');
        expect([...users[1].files.values()].join('')).not.toContain('alice private message');
        expect(JSON.stringify(await users[0].connections.snapshot())).not.toContain('alice-token');
        expect(logs.join('')).not.toMatch(/private message|-token|-secret/);
        await users[0].connections.remove('personal');
        await expect(users[0].connections.resolve('personal', 'google-workspace')).rejects.toThrow('TOOL_CONNECTION_NOT_FOUND');
        expect((await users[1].connections.resolve('personal', 'google-workspace')).refreshToken).toBe('bob-token');
    } finally {await Promise.all(users.map(user => user.connections.close())); vi.unstubAllGlobals(); await rm(root, {recursive: true, force: true});}
});
