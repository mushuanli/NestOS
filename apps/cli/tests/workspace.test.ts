import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspacePort, WorkspaceGrantRegistry } from '../src/workspace';

describe('workspace boundary', () => {
    it('denies write requests even when the saved grant used to be writable', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'nestos-readonly-'));
        const registry = new WorkspaceGrantRegistry(root, path.join(root, '.nestos'), [
            { id: 'external', path: '/external', access: 'write', createdAt: 1 },
        ], undefined, true);
        expect(registry.list()[0].access).toBe('read');
        expect(registry.permits(path.join(root, 'file'), 'write')).toBe(false);
        expect(registry.permits('/external/file', 'write')).toBe(false);
        await expect(registry.grant(root, 'write')).rejects.toThrow('cannot acquire writable mounts');
    });
    it('allows workspace files and rejects traversal and symlink escapes', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'nestos-workspace-'));
        const outside = await mkdtemp(path.join(tmpdir(), 'nestos-outside-'));
        await mkdir(path.join(root, '.nestos'));
        await writeFile(path.join(root, 'inside.txt'), 'inside');
        await writeFile(path.join(outside, 'secret.txt'), 'secret');
        await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
        const canonicalRoot = await realpath(root);
        const registry = new WorkspaceGrantRegistry(canonicalRoot, path.join(canonicalRoot, '.nestos'));
        const port = createWorkspacePort(registry);
        await expect(port.readFile(path.join(root, 'inside.txt'))).resolves.toBe('inside');
        await expect(port.readFile(path.join(root, '..', path.basename(outside), 'secret.txt'))).rejects.toThrow('outside');
        await expect(port.readFile(path.join(root, 'escape.txt'))).rejects.toThrow('outside');
        await expect(port.readFile(path.join(root, '.nestos', 'run.json'))).rejects.toThrow();
    });

    it('permits an explicitly granted external directory', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'nestos-workspace-'));
        const outside = await mkdtemp(path.join(tmpdir(), 'nestos-outside-'));
        await writeFile(path.join(outside, 'allowed.txt'), 'ok');
        const registry = new WorkspaceGrantRegistry(root, path.join(root, '.nestos'));
        await registry.grant(outside, 'read');
        await expect(createWorkspacePort(registry).readFile(path.join(outside, 'allowed.txt'))).resolves.toBe('ok');
    });
});

it('reports the actual Session mount path after an approved directory grant', async () => {
    const { createWorkspaceAccessTool } = await import('../src/workspace');
    const { rm } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-grant-path-'));
    try {
        const registry = new WorkspaceGrantRegistry(root, path.join(root, '.nestos'));
        registry.setOnGrant(async grant => { grant.mountAt = '/reference'; });
        const result = await createWorkspaceAccessTool(registry).call({ path: root, access: 'read', reason: 'reference' });
        expect(result.data).toMatchObject({ sandboxPath: '/reference', access: 'read' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
