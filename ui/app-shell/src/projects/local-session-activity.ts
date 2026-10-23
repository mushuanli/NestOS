import {createModuleLogger, randomUUID} from '@itookit/common';
import {resolveBrowserTarget} from '@itookit/app-contracts';
import type {KernelViewPort, SessionActivity} from '@itookit/durable-kernel/contracts';
import type {VFSNodeUI, VFSUIShell} from '@itookit/vfs-ui';
import {localSessionStatus} from './local-session-status';

const log = createModuleLogger('workbench-activity');

/** Project loaded row metadata only; never writes VFS or reloads the directory tree. */
export class LocalSessionActivityView {
    private readonly dirty = new Map<string, Set<string>>();
    private tail = Promise.resolve();
    private retryTimer?: ReturnType<typeof setTimeout>;
    private retryDelay = 1000;
    private closed = false;
    constructor(private readonly kernel: KernelViewPort, private readonly ui: () => VFSUIShell | undefined,
        private readonly visible: () => boolean, private readonly sessionPath: (id: string) => Promise<string>, private readonly retry?: () => void) {}
    invalidate(sessionId: string, taskId?: string): void {
        const tasks = this.dirty.get(sessionId) ?? new Set<string>(); if (taskId) tasks.add(taskId); this.dirty.set(sessionId, tasks);
    }
    refresh(): Promise<void> {
        this.tail = this.tail.catch(() => {}).then(() => this.refreshNow()); return this.tail;
    }
    private async refreshNow(): Promise<void> {
        if (this.closed || !this.visible()) return;
        if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined;
        const pending = [...this.dirty]; this.dirty.clear();
        let failed = false;
        for (const [id, tasks] of pending) {
            if (!this.visible()) {this.retain(id, tasks); continue;}
            const started = performance.now(), operationId = randomUUID();
            try {await this.project(id, tasks);}
            catch (error) {
                if (!missingActivityResource(error)) {failed = true; this.retain(id, tasks);}
                log.warn('session.activity', {operationId, stage: 'project', outcome: 'error', sessionId: id,
                durationMs: Math.round(performance.now() - started), errorType: (error as {code?: string})?.code ?? 'ACTIVITY_READ_FAILED'});}
        }
        if (failed) this.scheduleRetry(); else this.retryDelay = 1000;
    }
    close(): void {this.closed = true; if (this.retryTimer) clearTimeout(this.retryTimer); this.dirty.clear();}
    private scheduleRetry(): void {
        if (this.closed || !this.retry || this.retryTimer) return;
        this.retryTimer = setTimeout(() => {this.retryTimer = undefined; if (!this.closed && this.visible()) this.retry?.();}, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    }
    private async project(id: string, tasks: Set<string>): Promise<void> {
        const ui = this.ui(); if (!ui?.getNode || !this.kernel.sessionActivity) return;
        const path = await this.sessionPath(id), nodes = loadedNodes(ui, path), sessions = nodes.filter(node => sessionNode(node, id));
        const activity = sessions.length ? await this.kernel.sessionActivity(id) : undefined;
        if (!this.visible()) {this.retain(id, tasks); return;}
        if (activity) for (const node of sessions) updateActivity(ui, node, activity);
        for (const taskId of tasks) {
            const taskNode = nodes.find(node => node.id === `${path}/tasks/${taskId}`);
            if (!taskNode) continue;
            let task;
            try {task = await this.kernel.task(id, taskId);}
            catch (error) {if (missingActivityResource(error)) continue; throw error;}
            if (!this.visible() || this.closed) {this.retain(id, tasks); return;}
            ui.updateNodeMetadata(taskNode.id, {title: `${task.program.kind} · ${task.status} · ${task.id}`,
                lastModified: new Date(task.updatedAt).toISOString()});
        }
        const directory = path + '/tasks';
        if (ui.getSnapshot?.().expandedIds.includes(directory) && (!tasks.size || [...tasks].some(task => !ui.getNode(`${directory}/${task}`))))
            await ui.loadDirectory(directory);
    }
    private retain(id: string, tasks: Set<string>): void {
        this.invalidate(id); for (const task of tasks) this.invalidate(id, task);
    }
}

function missingActivityResource(error: unknown): boolean {
    return ['ENOENT', 'SESSION_NOT_FOUND', 'TASK_NOT_FOUND'].includes(String((error as {code?: unknown})?.code));
}

function loadedNodes(ui: VFSUIShell, path: string): VFSNodeUI[] {
    const roots = new Set([path, path + '/tasks', ...(ui.getSnapshot?.().expandedIds ?? [])]);
    for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) roots.add(path.slice(0, index));
    const nodes = new Map<string, VFSNodeUI>();
    const visit = (node?: VFSNodeUI) => {if (!node || nodes.has(node.id)) return; nodes.set(node.id, node); node.children?.forEach(visit);};
    for (const root of roots) visit(ui.getNode(root));
    return [...nodes.values()];
}
function sessionNode(node: VFSNodeUI, sessionId: string): boolean {
    try {const target = resolveBrowserTarget(String(node.metadata.custom.navigationTarget ?? node.id));
        return target.kind === 'session' && target.sessionId === sessionId;}
    catch {return false;}
}
function updateActivity(ui: VFSUIShell, node: VFSNodeUI, activity: SessionActivity): void {
    const old = node.metadata.custom.sessionActivity, modified = activity.latestExit?.at;
    const lastModified = modified && modified > Date.parse(node.metadata.lastModified) ? new Date(modified).toISOString() : node.metadata.lastModified;
    if (JSON.stringify(localSessionStatus(old)) === JSON.stringify(localSessionStatus(activity)) && lastModified === node.metadata.lastModified) return;
    ui.updateNodeMetadata(node.id, {lastModified, custom: {...node.metadata.custom, sessionActivity: activity}});
}
