import type { ISessionRepository } from '@itookit/llm-session';
import type { Kernel, TaskRecord, TaskStatus } from '@itookit/durable-kernel';

export interface RunCatalogEntry {
    runId: string;
    sessionId: string;
    title: string;
    origin?: 'cli' | 'tauri' | 'web';
    status: TaskStatus;
    rootTaskId: string;
    createdAt: number;
    updatedAt: number;
}

/** Read-only run projection over the shared Session repository and Kernel records. */
export class RunCatalog {
    constructor(
        private readonly sessions: Pick<ISessionRepository, 'list' | 'getManifest'>,
        private readonly kernel: Pick<Kernel, 'listSessionTasks'>,
    ) {}

    async list(sessionId?: string): Promise<RunCatalogEntry[]> {
        const sessions = sessionId ? [await this.sessions.getManifest(sessionId)] : await this.sessions.list();
        const entries: RunCatalogEntry[] = [];
        for (const session of sessions) {
            const tasks = await this.kernel.listSessionTasks(session.id);
            const roots = tasks.filter(task => task.labels?.kind === 'flow-root');
            for (const root of roots) {
                const members = tasks.filter(task => task.rootTaskId === root.id);
                entries.push({
                    runId: root.id,
                    sessionId: session.id,
                    title: session.title,
                    ...(session.origin ? { origin: session.origin } : {}),
                    status: aggregateStatus(members),
                    rootTaskId: root.id,
                    createdAt: root.createdAt,
                    updatedAt: members.reduce((max, task) => Math.max(max, task.updatedAt), root.updatedAt),
                });
            }
        }
        return entries.sort((left, right) => right.updatedAt - left.updatedAt);
    }
}

function aggregateStatus(tasks: TaskRecord[]): TaskStatus {
    if (!tasks.length) return 'succeeded';
    if (tasks.some(task => task.status === 'failed')) return 'failed';
    if (tasks.some(task => task.status === 'cancelled')) return 'cancelled';
    if (tasks.some(task => task.status === 'waiting')) return 'waiting';
    if (tasks.some(task => task.status === 'running')) return 'running';
    return 'succeeded';
}
