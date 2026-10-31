import {mkdtemp, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {NodeToolConnections} from '../src/runtime/tool-connections';

it('isolates identical connection IDs by user, redacts secrets and preserves them on edit and reopen', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-connections-'));
    const type = {id: 'example', name: 'Example', description: '', fields: [{name: 'token', label: 'Token', required: true, secret: true}]};
    const a = new NodeToolConnections(path.join(root, 'a')), b = new NodeToolConnections(path.join(root, 'b'));
    a.register(type); b.register(type);
    try {
        await a.save({id: 'personal', type: 'example', name: 'My account', values: {token: 'user-a-secret'}});
        await b.save({id: 'personal', type: 'example', name: 'My account', values: {token: 'user-b-secret'}});
        expect(await a.resolve('personal', 'example')).toEqual({token: 'user-a-secret'});
        expect(await b.resolve('personal', 'example')).toEqual({token: 'user-b-secret'});
        expect(JSON.stringify(await a.snapshot())).not.toContain('user-a-secret');
        expect((await a.snapshot()).connections[0].configuredSecrets).toEqual(['token']);
        await a.save({id: 'personal', type: 'example', name: 'Renamed', values: {token: ''}});
        const reopened = new NodeToolConnections(path.join(root, 'a')); reopened.register(type);
        expect(await reopened.resolve('personal', 'example')).toEqual({token: 'user-a-secret'});
        expect((await stat(path.join(root, 'a', 'connections.json'))).mode & 0o077).toBe(0);
        await a.remove('personal'); await expect(a.resolve('personal', 'example')).rejects.toThrow('TOOL_CONNECTION_NOT_FOUND');
        expect(await b.resolve('personal', 'example')).toEqual({token: 'user-b-secret'});
        await expect(b.resolve('personal', 'other')).rejects.toThrow('TOOL_CONNECTION_NOT_FOUND');
        await expect(b.save({id: '../a', type: 'example', name: 'Invalid', values: {token: 'secret'}})).rejects.toThrow('TOOL_CONNECTION_INVALID');
    } finally {await rm(root, {recursive: true, force: true});}
});

it('refuses a symlinked credential directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-connections-'));
    try {
        await symlink(root, path.join(root, 'link'));
        await expect(new NodeToolConnections(path.join(root, 'link')).snapshot()).rejects.toThrow('TOOL_CONNECTION_STORAGE_NOT_PRIVATE');
    } finally {await rm(root, {recursive: true, force: true});}
});

it('reports corrupt credential storage without returning a JSON excerpt containing secrets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-connections-'));
    try {
        await writeFile(path.join(root, 'connections.json'), '[{"secret":"PRIVATE_TOKEN", broken]', {mode: 0o600});
        await expect(new NodeToolConnections(root).snapshot()).rejects.toThrow('TOOL_CONNECTION_STORAGE_INVALID');
        const failure = await new NodeToolConnections(root).snapshot().catch(error => error);
        expect(String(failure)).not.toContain('PRIVATE_TOKEN');
    } finally {await rm(root, {recursive: true, force: true});}
});

it('reports unsupported online verification for generic keys and never logs invalid verification input', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-check-'));
    const fetcher = vi.fn(async () => {throw new Error('must not call provider');});
    const store = new NodeToolConnections(root, {fetcher});
    try {
        store.register({id: 'key-account', name: 'Key account', description: '', fields: [{name: 'token', label: 'Token', secret: true, required: true}]});
        await store.save({id: 'account', type: 'key-account', name: 'Account', values: {token: 'PRIVATE_TOKEN'}});
        expect(await store.verify('account')).toMatchObject({status: 'unsupported'}); expect(fetcher).not.toHaveBeenCalled();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(store.verify({private: 'PRIVATE_ARGUMENT'} as never)).rejects.toThrow('TOOL_CONNECTION_INVALID');
            expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_ARGUMENT');
        } finally {warning.mockRestore();}
    } finally {await store.close(); await rm(root, {recursive: true, force: true});}
});
