import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createSandboxLaunchPlan, selectSandboxBackend } from './launch';
import { assertPath, validatePolicy } from './policy';
import { SandboxError, type SandboxCommand, type SandboxLaunchPlan, type SandboxPolicy } from './types';

export interface PreparedSandbox {
    /** Build immediately before spawning; cwd is resolved against the frozen grants. */
    wrap(request: SandboxCommand): SandboxLaunchPlan;
}

export function prepareSandbox(policy: SandboxPolicy, executable?: string): PreparedSandbox {
    const backend = selectSandboxBackend(process.platform);
    validatePolicy(policy);
    const canonical: SandboxPolicy = {
        readOnlyPaths: (policy.readOnlyPaths ?? []).map(canonicalDirectory),
        writablePaths: (policy.writablePaths ?? []).map(canonicalDirectory),
        network: policy.network ?? 'deny',
    };
    validatePolicy(canonical);
    const binary = executable ?? (backend === 'seatbelt' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap');
    assertPath(binary);
    try { accessSync(binary, constants.X_OK); }
    catch { throw new SandboxError('UNAVAILABLE', `Sandbox executable is unavailable: ${binary}`); }
    return { wrap: request => createSandboxLaunchPlan(backend, canonical,
        { ...request, cwd: canonicalDirectory(request.cwd) }, binary) };
}

/** Probe real isolation setup, not just the presence/version of the executable. */
export function probeSandbox(sandbox: PreparedSandbox, cwd: string): void {
    const plan = sandbox.wrap({ command: '/bin/sh', args: ['-c', 'exit 0'], cwd });
    const result = spawnSync(plan.command, plan.args, {
        cwd: plan.cwd, env: plan.env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
        throw new SandboxError('UNAVAILABLE', `Sandbox startup failed: ${result.error?.message ?? result.stderr.trim()}`);
    }
}

function canonicalDirectory(path: string): string {
    assertPath(path);
    try {
        const canonical = realpathSync(path);
        if (!statSync(canonical).isDirectory()) throw new Error('Not a directory');
        return canonical;
    } catch {
        throw new SandboxError('INVALID_POLICY', `Sandbox directory is unavailable: ${path}`);
    }
}
