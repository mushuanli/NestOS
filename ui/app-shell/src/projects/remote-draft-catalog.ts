import {createModuleLogger, ENTITY_ICONS, randomUUID, t} from '@itookit/common';
import type {ProjectService, ProjectFolder} from '@itookit/app-contracts/services';

const log = createModuleLogger('remote-draft-catalog');
/** A model read reuses this editor's profile discovery; the backend revalidates its grant. */
export function remoteDraftCatalog(projects: ProjectService, folder: string, initialProject?: ProjectFolder | null) {
    let catalog: {projectId: string; entries: Awaited<ReturnType<typeof readProfiles>>} | undefined;
    const list = async () => {
        const operationId = randomUUID(), started = performance.now(); catalog = undefined;
        try {
            const project = initialProject !== undefined ? initialProject : await projects.forFolder(folder); initialProject = undefined;
            if (!project) return [];
            const entries = await readProfiles(projects, project); catalog = {projectId: project.project.id, entries};
            log.debug('draft.executors', {operationId, stage: 'profiles', result: 'success', count: entries.length, durationMs: Math.round(performance.now() - started)});
            return entries;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.warn('draft.executors', {operationId, stage: 'profiles', result: 'failure',
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'REMOTE_EXECUTOR_READ_FAILED', durationMs: Math.round(performance.now() - started)});
            throw error;
        }
    };
    const models = async (id: string) => {
        if (!catalog) await list();
        if (!catalog?.entries.some(profile => profile.id === id && profile.supportsModels)) return {models: []};
        const [, , profileId] = JSON.parse(decodeURIComponent(id.slice('remote:'.length))) as string[];
        return projects.remoteMounts!.projectModels(catalog.projectId, profileId!, {timeoutMs: 30000});
    };
    return {list, models};
}
async function readProfiles(projects: ProjectService, project: ProjectFolder) {
    const remote = projects.remoteMounts!, mount = remote.list(project.project.id).find(m => m.at === '/' && m.serverProjectId && m.access === 'rw');
    if (!mount) return [];
    const client = await remote.projectHarness(project.project.id, {timeoutMs: 3000});
    try {
        return (await client.profiles({timeoutMs: 3000})).profiles.filter(p => p.projectRuntime && p.capabilities.create)
            .map(p => ({id: 'remote:' + encodeURIComponent(JSON.stringify([mount.connectionId, mount.serverProjectId, p.id])),
                name: `${remote.connectionName(mount.connectionId!) ?? project.displayName ?? project.name} · ${p.kind} · ${p.id}`,
                icon: ENTITY_ICONS.remoteAgent, category: t('harness.remoteAgents'), supportsModels: !!p.capabilities.models, attachmentKinds: p.capabilities.attachments}));
    } finally {await client.close();}
}
