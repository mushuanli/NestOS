import { acquireWorkspaceProcessContext, type ApplicationPlatformServices, type HeadlessKernelRuntime } from '@itookit/app-core';
import { randomUUID } from '@itookit/common';
import { GitWorktreeFlowWorkspaceManager, readFlowSchedulerCheckpoint, type FlowWorkspaceLease, type FlowWorkspaceManager } from '@itookit/llm-flow';
import { TauriFsOps } from '../fs/tauri-fs-ops';
import { resolveTauriWorkspaceGrant, type TauriWorkspaceGrant } from './workspace-grant';
import { TauriWorkspaceGitRunner } from './workspace-git';
import { TauriSessionDirectories } from '../services/session-directories';
import { createTauriSessionProcesses } from './session-bash';
import { invoke } from '@tauri-apps/api/core';

type Policy = Parameters<FlowWorkspaceManager['prepare']>[1];
type SavedValue = Parameters<NonNullable<FlowWorkspaceManager['restore']>>[2];
type RestoreOptions = Parameters<NonNullable<FlowWorkspaceManager['restore']>>[3];
interface SavedWorkspace { version: 1; id: string; directory: string; grant: TauriWorkspaceGrant; git: SavedValue; mode?: 'worktree' | 'read-only'; }

/** Host authorization wraps the shared Git lifecycle; each preparation owns a unique copy. */
export class TauriFlowWorkspaces implements FlowWorkspaceManager {
    private services?: ApplicationPlatformServices;
    private kernel?: HeadlessKernelRuntime;
    private readonly preparing = new Set<string>();
    private readonly reconciliations = new Map<string, Promise<void>>();
    private intentsDirectory?: Promise<void>;
    private readonly parent: string;
    constructor(private readonly rootDir: string) { this.parent = `${rootDir.replace(/\/$/, '')}/var/lib/worktrees`; }
    bind(kernel: HeadlessKernelRuntime, services: ApplicationPlatformServices): void { this.kernel = kernel; this.services = services; }

    async fileContext(sessionId: string, rootTaskId: string) {
        if (!this.kernel || !this.services) throw new Error('Desktop workspace services are not bound');
        const session = await this.kernel.kernel.inspectSession(sessionId);
        const record = await session.getShared(`flow.run.${rootTaskId}.workspace-lease`);
        const saved = await this.validate(sessionId, record?.value ?? null);
        const frozen = await readFlowSchedulerCheckpoint(session, rootTaskId);
        if (frozen?.spec?.runPolicy?.workspace?.mode !== (saved.mode ?? 'worktree')) {
            throw new Error('Workspace lease mode does not match the frozen policy');
        }
        const sources = new TauriSessionDirectories(this.rootDir);
        let context: Awaited<ReturnType<typeof acquireWorkspaceProcessContext>> | undefined;
        try {
            const fs = await sources.openDirectory(saved.directory);
            context = await acquireWorkspaceProcessContext(this.services.sessionFiles, sessionId,
                { mountId: saved.grant.mountId, fs, directory: saved.directory, access: saved.mode === 'read-only' ? 'ro' : 'rw' }, createTauriSessionProcesses(this.rootDir),
                () => this.services!.directoryMounts.processMounts(sessionId));
            await this.assertGrant(saved.grant);
            let releasing: Promise<void> | undefined;
            const acquired = context;
            return { ...context, release: () => {
                if (releasing) return releasing;
                const pending = releaseWorkspace(acquired, sources);
                releasing = pending;
                void pending.catch(() => { if (releasing === pending) releasing = undefined; });
                return pending;
            } };
        } catch (error) {
            try { await releaseWorkspace(context, sources); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Workspace capability acquisition and cleanup failed'); }
            throw error;
        }
    }

    async prepare(sessionId: string, policy: Policy): Promise<FlowWorkspaceLease> {
        gitPolicy(policy);
        await this.reconcile(sessionId);
        const grant = await this.grant(sessionId);
        const id = randomUUID(), directory = `${this.parent}/${id}`;
        this.preparing.add(id);
        try { return await this.prepareCopy(grant, id, directory, policy); }
        catch (error) { this.preparing.delete(id); throw error; }
    }

    private async prepareCopy(grant: TauriWorkspaceGrant, id: string, directory: string, policy: Policy): Promise<FlowWorkspaceLease> {
        await new TauriFsOps().mkdir(this.parent);
        const mode = policy.mode as 'worktree' | 'read-only';
        const manager = this.manager(grant, directory, git => this.saveIntent({ version: 1, id, directory, grant, git, mode }));
        const lease = await manager.prepare(id, gitPolicy(policy));
        try {
            await this.assertGrant(grant);
            if (!lease.record) throw new Error('Git workspace lease has no durable record');
            return this.wrap(lease, { version: 1, id, directory, grant, git: lease.record, mode });
        } catch (error) {
            try {
                const cleanup = await manager.restore(id, { mode: 'worktree', cleanup: 'always', merge: 'discard' }, lease.record!);
                await cleanup.finish('cancelled');
                await this.removeIntent(id);
            } catch (cleanup) { throw new AggregateError([error, cleanup], 'Workspace preparation and cleanup failed'); }
            throw error;
        }
    }

    /** Called only while the execution host owns this Session's write lease. */
    reconcile(sessionId: string): Promise<void> {
        const existing = this.reconciliations.get(sessionId);
        if (existing) return existing;
        const pending = this.reconcileIntents(sessionId).finally(() => this.reconciliations.delete(sessionId));
        this.reconciliations.set(sessionId, pending);
        return pending;
    }

    private async reconcileIntents(sessionId: string): Promise<void> {
        if (!this.kernel) throw new Error('Desktop workspace services are not bound');
        await this.ensureIntentsDirectory();
        const entries = await invoke<Array<{ name: string; is_directory: boolean }>>('fs_read_dir', { path: `${this.parent}/.intents` });
        // Retained intents are shared by every Session. Without a candidate file this Session
        // needs neither its Task list nor its workspace leases, so recovery can skip it.
        const candidates = entries.filter(entry => !entry.is_directory && /^[0-9a-f-]{36}\.json$/i.test(entry.name));
        if (candidates.length === 0) return;
        const session = await this.kernel.kernel.inspectSession(sessionId).catch(error => {
            throw new Error(`Cannot inspect Session ${sessionId}; workspace intents are retained in ${this.parent}/.intents. Reopen the Session before retrying.`, { cause: error });
        });
        const roots = (await session.listTasks()).filter(task => task.program.kind === 'flow.aggregate' && task.labels?.kind === 'flow-root');
        const claimed = new Set<string>();
        for (const root of roots) {
            const record = await session.getShared(`flow.run.${root.id}.workspace-lease`);
            const initial = (root.input as { initialWorkspace?: SavedValue } | undefined)?.initialWorkspace;
            const value = record?.value ?? initial;
            if (value) claimed.add(parseSaved(value).id);
        }
        for (const entry of candidates) {
            const bytes = await invoke<ArrayBuffer>('fs_read_file', { path: `${this.parent}/.intents/${entry.name}` });
            const saved = parseSaved(JSON.parse(new TextDecoder().decode(bytes)));
            if (saved.grant.sessionId !== sessionId || this.preparing.has(saved.id) || claimed.has(saved.id)) continue;
            if (entry.name !== `${saved.id}.json`) throw new Error('Workspace intent identity does not match its filename');
            await this.validate(sessionId, { ...saved, grant: { ...saved.grant } }).catch(error => {
                throw new Error(`Retained workspace ${saved.directory}: ${String(error)}. Restore the original Session grant or resolve this retained worktree manually before retrying.`, { cause: error });
            });
            const cleanup = await this.manager(saved.grant, saved.directory).restore(saved.id,
                { mode: 'worktree', cleanup: 'always', merge: 'discard' }, saved.git, { forFinalization: true });
            await cleanup.finish('cancelled');
            await this.removeIntent(saved.id);
        }
    }

    async restore(sessionId: string, policy: Policy, value: SavedValue, options?: RestoreOptions): Promise<FlowWorkspaceLease> {
        const saved = await this.validate(sessionId, value);
        if ((saved.mode ?? 'worktree') !== policy.mode) throw new Error('Workspace lease mode does not match the frozen policy');
        const lease = await this.manager(saved.grant, saved.directory).restore(saved.id, gitPolicy(policy), saved.git, options);
        await this.assertGrant(saved.grant);
        return this.wrap(lease, saved);
    }

    async validate(sessionId: string, value: SavedValue): Promise<SavedWorkspace> {
        const saved = parseSaved(value);
        if (saved.grant.sessionId !== sessionId || saved.directory !== `${this.parent}/${saved.id}`) {
            throw new Error('Workspace lease belongs to another Session or data root');
        }
        await this.assertGrant(saved.grant);
        return saved;
    }

    private grant(sessionId: string) {
        if (!this.services) throw new Error('Desktop workspace services are not bound');
        return resolveTauriWorkspaceGrant(this.services, sessionId, this.rootDir);
    }
    private async assertGrant(saved: TauriWorkspaceGrant): Promise<void> {
        const current = await this.grant(saved.sessionId);
        if (Object.entries(current).some(([key, value]) => saved[key as keyof TauriWorkspaceGrant] !== value)) {
            throw new Error('Workspace lease authorization no longer matches the Session');
        }
    }
    private manager(grant: TauriWorkspaceGrant, directory: string, beforeCreate?: (record: SavedValue) => Promise<void>) {
        return new GitWorktreeFlowWorkspaceManager({ repository: grant.repository, directoryFor: () => directory,
            commands: new TauriWorkspaceGitRunner(grant.repository, directory), beforeCreate });
    }
    private intentPath(id: string) { return `${this.parent}/.intents/${id}.json`; }
    /** The retained-intent directory is created once per process instead of per recovered Session. */
    private async ensureIntentsDirectory(): Promise<void> {
        this.intentsDirectory ??= (async () => { await new TauriFsOps().mkdir(`${this.parent}/.intents`); })();
        const pending = this.intentsDirectory;
        try { await pending; }
        catch (error) { if (this.intentsDirectory === pending) this.intentsDirectory = undefined; throw error; }
    }
    private async removeIntent(id: string): Promise<void> {
        await invoke('fs_remove', { path: this.intentPath(id), recursive: false });
        this.preparing.delete(id);
    }
    private async saveIntent(saved: SavedWorkspace): Promise<void> {
        const fs = new TauriFsOps();
        await fs.mkdir(`${this.parent}/.intents`);
        await fs.writeFile(this.intentPath(saved.id), new TextEncoder().encode(JSON.stringify(saved)).buffer);
    }
    private wrap(lease: FlowWorkspaceLease, saved: SavedWorkspace): FlowWorkspaceLease {
        return { directory: saved.grant.at, record: { ...saved, grant: { ...saved.grant } },
            finish: async status => {
                await this.assertGrant(saved.grant);
                const result = await lease.finish(status);
                await this.removeIntent(saved.id);
                return result;
            } };
    }
}

async function releaseWorkspace(context: { release(): Promise<void> } | undefined, sources: TauriSessionDirectories): Promise<void> {
    await context?.release();
    await sources.dispose();
}

function parseSaved(value: SavedValue): SavedWorkspace {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop workspace lease');
    const saved = value as unknown as SavedWorkspace;
    if (saved.mode !== undefined && saved.mode !== 'worktree' && saved.mode !== 'read-only') throw new Error('Invalid desktop workspace mode');
    if (saved.version !== 1 || typeof saved.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(saved.id)
        || typeof saved.directory !== 'string' || !saved.grant || typeof saved.grant !== 'object'
        || !saved.git || typeof saved.git !== 'object' || Array.isArray(saved.git)) throw new Error('Invalid desktop workspace lease');
    if (saved.git.directory !== saved.directory || typeof saved.git.branch !== 'string'
        || !saved.git.branch.startsWith(`flow/${saved.id}-`)) throw new Error('Git lease does not match the desktop workspace');
    return saved;
}

function gitPolicy(policy: Policy): Policy {
    if (policy.mode === 'worktree') return policy;
    if (policy.mode !== 'read-only') throw new Error(`Unsupported desktop workspace mode: ${policy.mode}`);
    if (policy.merge && policy.merge !== 'discard') throw new Error('Read-only workspaces cannot merge changes');
    return { ...policy, mode: 'worktree', merge: 'discard' };
}
