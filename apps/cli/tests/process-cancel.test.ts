// @file: apps/cli/tests/process-cancel.test.ts
// Real process-tree evidence for Effect cancellation: the adapter may only confirm
// cancellation once the process group has actually exited, not when the signal was sent.
// Runs the product native shell (NodeNativeShell) and the product Bash tool, no stubs.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { BashEffectAdapter } from '@itookit/kernel-adapters';
import { ToolDeviceDriver, createBashTool } from '@itookit/tools';
import { NodeNativeShell } from '../src/shell';

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function context(signal: AbortSignal): EffectExecutionContext {
    return {
        sessionId: 'session-a', taskId: 'task-a', effectId: 'effect-a', abortSignal: signal,
        grants: [{
            handleId: 'process-handle', right: 'execute',
            resource: { id: 'process-resource', sessionId: 'session-a', kind: 'process',
                uri: 'process://pending', generation: 1, createdAt: Date.now() },
        }],
        emit: async () => undefined,
    };
}

async function waitForPid(file: string): Promise<number> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            const pid = Number((await readFile(file, 'utf8')).trim());
            if (Number.isSafeInteger(pid) && pid > 0) return pid;
        } catch { /* not written yet */ }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('process did not report its pid');
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

it.skipIf(process.platform === 'win32')('confirms cancellation only after the process group has exited', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-process-cancel-'));
    roots.push(directory);
    const pidFile = path.join(directory, 'pid');
    const driver = new ToolDeviceDriver([createBashTool(new NodeNativeShell())]);
    const adapter = new BashEffectAdapter(() => driver);
    const controller = new AbortController();
    // The group ignores SIGTERM: only the shell's SIGKILL escalation can stop it, and the
    // adapter must not resolve cleanup before that actually happened.
    const request = { resourceHandleId: 'process-handle',
        command: `trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 1; done` };
    const execution = adapter.execute(request, context(controller.signal));
    const pid = await waitForPid(pidFile);
    expect(alive(pid)).toBe(true);

    controller.abort();
    await adapter.cancel(request, context(controller.signal));
    expect(alive(pid)).toBe(false);
    // The tool reports the forced timeout as a completed invocation, which is what the
    // Kernel records as a cleaned-up cancellation.
    await expect(execution).resolves.toMatchObject({ success: true });
    expect((await execution).output).toContain('[timeout]');
}, 30_000);

it.skipIf(process.platform !== 'linux')('stops background descendants even when their parent exits and their output pipes are closed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-background-cancel-'));
    roots.push(directory);
    const pidFile = path.join(directory, 'pid');
    let pid: number | undefined;
    try {
        const execution = new NodeNativeShell().exec('bash', ['-c',
            `bash -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' >/dev/null 2>&1 & while [ ! -f ${pidFile} ]; do sleep 0.01; done`], { timeoutMs: 5000 });
        pid = await waitForPid(pidFile);
        await execution;
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
        expect(['', 'Z', 'X']).toContain(state);
    } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } } }
}, 10_000);

it('does not start a command when cancellation was requested before execution', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-preabort-'));
    roots.push(directory);
    const file = path.join(directory, 'started');
    const controller = new AbortController();
    controller.abort();
    await new NodeNativeShell().exec('sh', ['-c', `echo started > ${file}`], { signal: controller.signal });
    expect(await readFile(file, 'utf8').catch(() => undefined)).toBeUndefined();
});
