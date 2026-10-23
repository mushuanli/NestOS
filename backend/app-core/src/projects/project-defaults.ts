import { createModuleLogger, randomUUID } from '@itookit/common';
import { FSError, type IFileSystem } from '@itookit/vfs-core';
import type { ProjectFolder } from '@itookit/app-contracts/services';

const path = '/etc/personal-project.json';
const log = createModuleLogger('project-default');
type Report = (stage: string, metadata?: Record<string, unknown>) => void;

/** The persisted project ID is authoritative; labels never imply ownership. */
export class ProjectDefaults {
    private pending: Promise<unknown> = Promise.resolve();
    constructor(private readonly fs: IFileSystem, private readonly list: () => Promise<ProjectFolder[]>,
        private readonly create: (replacement?: boolean) => Promise<ProjectFolder>, private readonly local: (project: ProjectFolder) => boolean) {}
    getId(): Promise<string | undefined> { return this.readId(); }
    async get(): Promise<ProjectFolder | undefined> {
        const [id, projects] = await Promise.all([this.readId(), this.list()]);
        return projects.find(project => project.project.id === id && this.local(project));
    }
    ensure(afterDeletion = false): Promise<ProjectFolder | undefined> {
        return this.serial('ensure', report => this.resolve(report, afterDeletion));
    }
    private async resolve(report: Report, afterDeletion: boolean): Promise<ProjectFolder | undefined> {
        report('read-default-and-catalog');
        const [id, projects] = await Promise.all([this.readId(), this.list()]);
        const saved = projects.find(project => project.project.id === id && this.local(project));
        if (saved) return saved;
        const existing = projects.find(this.local), replacement = afterDeletion || !!id;
        const create = !existing && (!projects.length || replacement);
        report(existing ? 'select-existing' : create ? replacement ? 'create-replacement' : 'create-empty-catalog' : 'no-local-project');
        const selected = existing ?? (create ? await this.create(replacement) : undefined);
        report('selection', { outcome: selected ? 'success' : 'unavailable', reason: afterDeletion ? 'DEFAULT_REMOVED' : !projects.length ? 'EMPTY_CATALOG' : id ? 'DEFAULT_MISSING' : 'DEFAULT_UNSET',
            previousProjectId: id, projectId: selected?.project.id, projectCount: projects.length });
        if (selected) { report('persist', {projectId: selected.project.id}); await this.writeId(selected.project.id); }
        return selected;
    }
    remove(id: string, remove: () => Promise<void>): Promise<ProjectFolder | undefined> {
        return this.serial('remove', async report => {
            report('read-default');
            const isDefault = await this.readId() === id;
            report('remove-project-source'); await remove();
            return isDefault ? this.resolve(report, true) : undefined;
        }, id);
    }
    set(id: string): Promise<void> {
        return this.serial('set', async report => {
            report('validate-local-project');
            const project = (await this.list()).find(item => item.project.id === id);
            if (!project) throw new FSError('ENOENT', 'Default project does not exist');
            if (!this.local(project)) throw new FSError('EINVAL', 'Default project must be local');
            report('persist'); await this.writeId(id);
        }, id);
    }
    private async serial<T>(action: string, work: (report: Report) => Promise<T>, projectId?: string): Promise<T> {
        const operationId = randomUUID(), started = performance.now(), operation = `project.default.${action}`;
        const next = this.pending.catch(() => {}).then(async () => {
            let stage = 'start';
            const report: Report = (nextStage, metadata) => { stage = nextStage;
                log.info('project.default.stage', { operation, operationId, stage, projectId, ...metadata }); };
            try {
                const result = await work(report);
                log.info('project.default.completed', { operation, operationId, stage: 'complete', outcome: 'success', projectId, durationMs: Math.round(performance.now() - started) });
                return result;
            } catch (error) {
                log.error('project.default.failed', { operation, operationId, stage, outcome: 'failure', projectId,
                    code: error instanceof FSError ? error.code : error instanceof SyntaxError ? 'DEFAULT_PROJECT_PARSE_FAILED' : 'DEFAULT_PROJECT_UNEXPECTED', durationMs: Math.round(performance.now() - started) });
                throw error;
            }
        });
        this.pending = next;
        return next;
    }
    private async readId(): Promise<string | undefined> {
        if (!await this.fs.driver.exists(path)) return undefined;
        const value = JSON.parse(await this.fs.driver.readContent(path, { encoding: 'utf-8', representation: 'bytes' }));
        if (!value || typeof value.id !== 'string') throw new FSError('EINVAL', 'Invalid default project identity');
        return value.id;
    }
    private async writeId(id: string): Promise<void> {
        const content = JSON.stringify({ id });
        if (await this.fs.driver.exists(path)) await this.fs.driver.writeContent(path, content);
        else await this.fs.driver.createFile({ parentPath: '/etc', name: 'personal-project.json', content, recursive: true });
    }
}
