import { describe, expect, it } from 'vitest';
import { NodeNativeShell, sandboxBaseArgs } from '../src/shell';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompiledWorkflow, WorkspaceGrant } from '../src/types';

it('maps native shell cwd through current Session mounts and rejects removed mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-native-cwd-'));
    await mkdir(join(root, 'sub'));
    let mounts: WorkspaceGrant[] = [{ id: 'main', mountAt: '/workspace', path: root, access: 'write', createdAt: 0 }];
    const shell = new NodeNativeShell(() => mounts);
    try {
        const result = await shell.exec('pwd', [], { cwd: '/workspace/sub' });
        expect(result.code).toBe(0); expect(result.stdout.trim()).toBe(join(root, 'sub'));
        await expect(shell.exec('pwd', [], { cwd: '/workspace/../../outside' })).rejects.toThrow('outside');
        mounts = [];
        await expect(shell.exec('pwd', [], { cwd: root })).rejects.toThrow('not mounted');
    } finally { await rm(root, { recursive: true, force: true }); }
});

describe('sandboxBaseArgs', () => {
    it.each([false, true])('uses Session mount paths for native and virtual cwd (interactive=%s)', interactive => {
        const grants: WorkspaceGrant[] = [
            { id: 'extra', path: '/external/data', mountAt: '/data', access: 'read', createdAt: 1 },
            { id: 'nested', path: '/host/workspace/vendor', mountAt: '/vendor', access: 'read', createdAt: 1 },
        ];
        for (const [cwd, expected] of [
            ['/external/data/sub', '/data/sub'], ['/data/sub', '/data/sub'],
            ['/workspace/sub', '/workspace/sub'], ['/host/workspace/vendor/sub', '/vendor/sub'],
        ]) {
            expect(pair(sandboxBaseArgs(workflow(), grants, cwd, interactive).args, '--workdir')).toBe(expected);
        }
        expect(() => sandboxBaseArgs(workflow(), grants, '/data/../../outside', interactive)).toThrow('outside');
    });
    it.each([false, true])('keeps all bind mounts read-only for read-only Runs (interactive=%s)', interactive => {
        const compiled = workflow(); compiled.config.runtime = { workspace: { mode: 'read-only' } };
        const grants: WorkspaceGrant[] = [
            { id: 'copy', path: '/host/copy', mountAt: '/workspace', access: 'write', createdAt: 1 },
            { id: 'extra', path: '/host/extra', mountAt: '/extra', access: 'write', createdAt: 1 },
        ];
        const { args } = sandboxBaseArgs(compiled, grants, '/host/copy/sub', interactive);
        expect(args).toContain('type=bind,src=/host/copy,dst=/workspace,ro');
        expect(args).toContain('type=bind,src=/host/extra,dst=/extra,ro');
        expect(pair(args, '--workdir')).toBe('/workspace/sub');
    });
    it('adds -i for interactive sessions (TTY) but not for one-shot exec', () => {
        const interactive = sandboxBaseArgs(workflow(), [], '/host/workspace', true);
        const oneShot = sandboxBaseArgs(workflow(), [], '/host/workspace', false);

        expect(interactive.args[0]).toBe('run');
        expect(interactive.args[1]).toBe('-i');
        expect(oneShot.args).not.toContain('-i');
    });

    it('bind-mounts the workspace to /workspace and maps the working directory', () => {
        const { args } = sandboxBaseArgs(workflow(), [], '/host/workspace/sub', true);

        expect(pair(args, '--mount')).toBe('type=bind,src=/host/workspace,dst=/workspace,rw');
        expect(pair(args, '--workdir')).toBe('/workspace/sub');
    });

    it('mounts granted paths read-only and hides the state directory behind tmpfs', () => {
        const grant: WorkspaceGrant = { id: 'grant-1', path: '/external/data', access: 'read', createdAt: 1 };
        const { args } = sandboxBaseArgs(workflow(), [grant], '/host/workspace', true);

        expect(args).toContain('type=bind,src=/external/data,dst=/mnt/grants/grant-1,ro');
        expect(pair(args, '--tmpfs', 2)).toBe('/workspace/.nestos:rw,noexec,nosuid,nodev,size=16m');
    });

    it('enforces read-only root, no capabilities and network isolation', () => {
        const { args } = sandboxBaseArgs(workflow(), [], '/host/workspace', true);

        expect(args).toContain('--read-only');
        expect(args).toContain('--cap-drop=ALL');
        expect(pair(args, '--network')).toBe('none');
        expect(pair(args, '--pids-limit')).toBe('256');
    });

    it('forwards agent env into the container via --env and drops invalid keys', () => {
        const { args } = sandboxBaseArgs(workflow(), [], '/host/workspace', true, {
            FOO: 'bar',
            'INVALID KEY': 'x',
            '1LEADING': 'y',
        });

        expect(pair(args, '--env')).toBe('FOO=bar');
        expect(args.filter(item => item === '--env')).toHaveLength(1);
    });
});

function workflow(): CompiledWorkflow {
    return {
        config: {
            version: 1,
            name: 'test',
            goal: 'test',
            providers: [],
            connections: [],
            agents: [],
            tasks: [{ id: 'write', agent: 'a', description: 'd', workspace_access: 'write' }],
            result: { task: 'write', output: 'r' },
            sandbox: { mode: 'oci', engine: 'auto' },
        },
        workspaceRoot: '/host/workspace',
        stateDir: '/host/workspace/.nestos',
    } as unknown as CompiledWorkflow;
}

/** Return the value immediately following the flag name (or the nth occurrence). */
function pair(args: string[], flag: string, occurrence = 1): string | undefined {
    let seen = 0;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === flag && ++seen === occurrence) return args[index + 1];
    }
    return undefined;
}

it('does not recreate an unmounted workspace from the workflow path for Shell or TTY', async () => {
    const { OciSandboxShell, OciTtyDriver } = await import('../src/shell');
    const shell = new OciSandboxShell('docker', workflow(), async () => []);
    await expect(shell.exec('sh', ['-c', 'true'])).rejects.toThrow('Session workspace is not mounted');
    expect(() => new OciTtyDriver('docker', workflow(), []).spawn('sh')).toThrow('Session workspace is not mounted');
});
