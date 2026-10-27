import { runProcess } from './process-run';
import path from 'node:path';
import type { ITTYDriver, ITTYSession, ITTYSpawnOptions } from '@itookit/tools/contracts';
import { NodeTTYDriver } from '@itookit/device-tty';
import type { INativeShell, NativeShellResult, NativeShellOptions } from '@itookit/tools';
import type { CompiledWorkflow, SandboxConfig, WorkspaceGrant } from './types';

export interface SandboxDoctorResult {
    engine?: 'podman' | 'docker';
    available: boolean;
    message: string;
}

export class NodeNativeShell implements INativeShell {
    readonly capabilities = { ripgrep: false, fd: false };
    constructor(private readonly grants?: () => Promise<WorkspaceGrant[]> | WorkspaceGrant[]) {}

    async exec(
        command: string,
        args: string[],
        options: NativeShellOptions = {},
    ): Promise<NativeShellResult> {
        const invocation = nativeInvocation(command, args);
        const cwd = this.grants ? nativeWorkingDirectory(await this.grants(), options.cwd) : options.cwd;
        return runProcess(invocation.command, invocation.args, {
            cwd,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            onOutput: options.onOutput,
            env: safeEnvironment(),
        });
    }
}

export class OciSandboxShell implements INativeShell {
    readonly capabilities = { ripgrep: false, fd: false };

    constructor(
        private readonly engine: 'podman' | 'docker',
        private readonly workflow: CompiledWorkflow,
        private readonly grants: () => Promise<WorkspaceGrant[]> | WorkspaceGrant[],
    ) {}

    async exec(
        command: string,
        args: string[],
        options: NativeShellOptions = {},
    ): Promise<NativeShellResult> {
        const shellCommand = command === 'sh' && args[0] === '-c' ? args[1] : quote([command, ...args]);
        const grants = await this.grants();
        requireSessionWorkspace(grants);
        const runArgs = sandboxArgs(this.workflow, grants, shellCommand, options.cwd);
        return runProcess(this.engine, runArgs, {
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            onOutput: options.onOutput,
            env: safeEnvironment(),
        });
    }
}

export interface ShellBinding {
    shell: INativeShell;
    /** Resolved container engine, present only in OCI mode. */
    engine?: 'podman' | 'docker';
}

export async function createShell(
    workflow: CompiledWorkflow,
    grants: () => Promise<WorkspaceGrant[]> | WorkspaceGrant[],
): Promise<ShellBinding> {
    if ((workflow.config.sandbox?.mode ?? 'oci') === 'native') return { shell: new NodeNativeShell(grants) };
    const doctor = await sandboxDoctor(workflow.config.sandbox?.engine ?? 'auto');
    if (!doctor.available || !doctor.engine) throw new Error(doctor.message);
    return { shell: new OciSandboxShell(doctor.engine, workflow, grants), engine: doctor.engine };
}

/**
 * Runs persistent interactive TTY sessions inside the OCI sandbox by wrapping
 * the host podman/docker binary in a long-lived `run -i` process. stdin/stdout
 * are piped through the same NodeTTYDriver I/O machinery used in native mode,
 * so the agent's shell_session/tty_write/tty_close tools keep working without
 * escaping the container.
 */
export class OciTtyDriver implements ITTYDriver {
    readonly supportsPty = false;
    private readonly delegate = new NodeTTYDriver();

    constructor(
        private readonly engine: 'podman' | 'docker',
        private readonly workflow: CompiledWorkflow,
        private readonly grants: WorkspaceGrant[],
    ) {}

    spawn(command: string, args: string[] = [], options: ITTYSpawnOptions = {}): ITTYSession {
        requireSessionWorkspace(this.grants);
        const { args: sandbox, image } = sandboxBaseArgs(this.workflow, this.grants, options.cwd, true, options.env);
        // The container working directory is expressed via --workdir; the host
        // podman/docker process itself runs from the host CWD and a clean env.
        // Agent-provided env is forwarded into the container via --env flags.
        return this.delegate.spawn(this.engine, [...sandbox, image, command, ...args], {
            ...options,
            cwd: undefined,
            env: undefined,
        });
    }
}

function requireSessionWorkspace(grants: WorkspaceGrant[]): void {
    if (!grants.some(grant => grant.mountAt === '/workspace')) {
        throw new Error('Session workspace is not mounted; configure it before executing commands');
    }
}

function nativeWorkingDirectory(grants: WorkspaceGrant[], cwd = '/workspace'): string {
    requireSessionWorkspace(grants);
    const virtual = path.posix.normalize(cwd);
    const mount = grants.filter(grant => grant.mountAt &&
        (virtual === grant.mountAt || virtual.startsWith(`${grant.mountAt}/`)))
        .sort((a, b) => b.mountAt!.length - a.mountAt!.length)[0];
    if (mount) return path.resolve(mount.path, path.posix.relative(mount.mountAt!, virtual));
    // Worktree managers can supply an already resolved host cwd.
    if (grants.some(grant => inside(grant.path, cwd))) return cwd;
    throw new Error(`Native working directory is outside mounted directories: ${cwd}`);
}

export async function sandboxDoctor(
    preferred: NonNullable<SandboxConfig['engine']> = 'auto',
): Promise<SandboxDoctorResult> {
    const candidates: Array<'podman' | 'docker'> = preferred === 'auto' ? ['podman', 'docker'] : [preferred];
    for (const engine of candidates) {
        const result = await runProcess(engine, ['version', '--format', '{{.Client.Version}}'], { timeoutMs: 5_000 });
        if (result.code === 0) return { engine, available: true, message: `${engine} is available` };
    }
    return { available: false, message: `OCI sandbox unavailable: install ${candidates.join(' or ')}` };
}

export function sandboxBaseArgs(
    workflow: CompiledWorkflow,
    grants: WorkspaceGrant[],
    cwd: string | undefined,
    interactive: boolean,
    env?: Record<string, string>,
): { args: string[]; image: string } {
    const sandbox = workflow.config.sandbox ?? {};
    const image = sandbox.image ?? 'nestos-sandbox:v1';
    const writable = workflow.config.tasks.some(task => task.workspace_access === 'write');
    const readOnly = workflow.config.runtime?.workspace?.mode === 'read-only';
    const workspaceGrant = grants.find(grant => grant.mountAt === '/workspace');
    const workspaceRoot = workspaceGrant?.path ?? workflow.workspaceRoot;
    const workspaceWritable = !readOnly && (workspaceGrant ? workspaceGrant.access === 'write' : writable);
    const args = [
        'run', ...(interactive ? ['-i'] : []), '--rm', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--network', sandbox.network ?? 'none', '--pids-limit', String(sandbox.limits?.pids ?? 256),
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m',
        '--mount', bindMount(workspaceRoot, '/workspace', workspaceWritable),
        '--workdir', containerWorkingDirectory(workspaceRoot, grants, cwd),
    ];
    if (sandbox.limits?.cpus) args.push('--cpus', String(sandbox.limits.cpus));
    if (sandbox.limits?.memory) args.push('--memory', sandbox.limits.memory);
    for (const [key, value] of Object.entries(env ?? {})) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
        args.push('--env', `${key}=${value}`);
    }
    const stateTarget = containerPath('/workspace', path.relative(workflow.workspaceRoot, workflow.stateDir));
    if (inside(workflow.workspaceRoot, workflow.stateDir)) {
        args.push('--tmpfs', `${stateTarget}:rw,noexec,nosuid,nodev,size=16m`);
    }
    for (const grant of grants) {
        if (grant.mountAt === '/workspace') continue;
        const target = grant.mountAt ?? `/mnt/grants/${grant.id}`;
        args.push('--mount', bindMount(grant.path, target, !readOnly && grant.access === 'write'));
    }
    return { args, image };
}

function sandboxArgs(
    workflow: CompiledWorkflow,
    grants: WorkspaceGrant[],
    shellCommand: string,
    cwd?: string,
): string[] {
    const { args, image } = sandboxBaseArgs(workflow, grants, cwd, false);
    return [...args, image, '/bin/sh', '-c', shellCommand];
}

function containerWorkingDirectory(root: string, grants: WorkspaceGrant[], cwd?: string): string {
    if (!cwd) return '/workspace';
    const mounts = [
        { source: root, target: '/workspace' },
        ...grants.filter(grant => grant.mountAt !== '/workspace').map(grant => ({
            source: grant.path, target: grant.mountAt ?? `/mnt/grants/${grant.id}`,
        })),
    ];
    // Prefer the most specific host mount when grants contain nested directories.
    const native = mounts.filter(mount => inside(mount.source, cwd))
        .sort((a, b) => b.source.length - a.source.length)[0];
    if (native) return containerPath(native.target, path.relative(native.source, cwd));
    const virtual = path.posix.normalize(cwd);
    if (mounts.some(mount => virtual === mount.target || virtual.startsWith(`${mount.target}/`))) return virtual;
    throw new Error(`OCI working directory is outside mounted directories: ${cwd}`);
}

function containerPath(root: string, relative: string): string {
    return path.posix.join(root, ...relative.split(path.sep).filter(Boolean));
}

function bindMount(source: string, target: string, writable: boolean): string {
    return `type=bind,src=${source},dst=${target},${writable ? 'rw' : 'ro'}`;
}

function nativeInvocation(command: string, args: string[]): { command: string; args: string[] } {
    if (process.platform !== 'win32') return { command, args };
    if (command === 'sh' && args[0] === '-c') {
        return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', args[1] ?? ''] };
    }
    return { command, args };
}

function safeEnvironment(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY)/i.test(key)));
}

function quote(values: string[]): string {
    return values.map(value => `'${value.replace(/'/g, `'"'"'`)}'`).join(' ');
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
