import { shellOutputChannel } from './shell-output-channel';
import { invoke } from '@tauri-apps/api/core';
import type { ApplicationKernelPlatform } from '@itookit/app-core';
import { randomUUID } from '@itookit/common';

type Factory = NonNullable<ApplicationKernelPlatform['createSessionProcesses']>;

/** Only explicit Session mounts are translated into native directory handles. */
export function createTauriSessionProcesses(rootDir: string): Factory {
    return async (_sessionId, files, mounts) => {
        const grants: Array<[string, string, boolean]> = [];
        try {
            for (const mount of mounts) {
                const path = mount.sourceId === 'admin-home' ? rootDir.replace(/\/$/, '') + mount.directory : mount.directory;
                const scope = await invoke<{ id: string }>('directory_open', { path });
                grants.push([scope.id, mount.at, mount.access === 'rw']);
            }
        } catch (error) {
            try { await releaseProcesses([], grants); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Session process initialization and cleanup failed'); }
            throw error;
        }
        return scopedProcesses(files, grants);
    };
}

function scopedProcesses(files: Parameters<Factory>[1], grants: Array<[string, string, boolean]>): Awaited<ReturnType<Factory>> {
    let closed = false;
    let releasing: Promise<void> | undefined;
    const active = new Map<string, Promise<unknown>>();
    return {
        nativeShell: { capabilities: { ripgrep: false, fd: false }, async exec(command, args, options) {
            if (closed) throw new Error('Session process scope closed');
            if (!['sh', 'bash'].includes(command) || args.length !== 2 || args[0] !== '-c') throw new Error('Session Bash requires a shell command string');
            const cwd = options?.cwd ?? files.cwd;
            // Existence check only: listFiles() walks the whole subtree, which is
            // prohibitive for a repository root. Fall back to it for hosts without stat().
            if (files.vfs.stat) {
                if (await files.vfs.stat(cwd) !== 'directory') throw new Error(`Session working directory is unavailable: ${cwd}`);
            } else await files.vfs.listFiles(cwd);
            if (closed) throw new Error('Session process scope closed');
            options?.signal?.throwIfAborted();
            const requestId = randomUUID();
            const cancel = () => { void invoke('shell_cancel', { requestId }).catch(() => {}); };
            options?.signal?.addEventListener('abort', cancel, { once: true });
            const output = shellOutputChannel(options?.onOutput);
            const result = invoke<[string, string, number]>('session_shell_exec', {
                onOutput: output.channel, command: args[1], cwd, mounts: grants, requestId, timeoutMs: options?.timeoutMs ?? 30_000,
            });
            active.set(requestId, result);
            try { const [stdout, stderr, code] = await result; return { stdout, stderr, code }; }
            finally { output.close(); active.delete(requestId); options?.signal?.removeEventListener('abort', cancel); }
        } },
        release() {
            closed = true;
            if (releasing) return releasing;
            const pending = releaseProcesses([...active], grants);
            releasing = pending;
            void pending.catch(() => { if (releasing === pending) releasing = undefined; });
            return pending;
        },
    };
}

async function releaseProcesses(active: Array<[string, Promise<unknown>]>, grants: Array<[string, string, boolean]>): Promise<void> {
    const cancellations = await Promise.allSettled(active.map(([requestId]) => invoke('shell_cancel', { requestId })));
    await Promise.allSettled(active.map(([, result]) => result));
    const closures = await Promise.allSettled([...grants].map(async grant => {
        await invoke('directory_close', { id: grant[0] });
        grants.splice(grants.indexOf(grant), 1);
    }));
    const errors = [...cancellations, ...closures].filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Session process cleanup failed');
}
