import { navigationView, warmNavigation } from './navigation-view';
import { createFileSystemView, FSError } from '@itookit/vfs-core';
import { withConfigurationImport } from '../configuration/configuration-import';
import { SettingsService } from '../settings/SettingsService';
import { OcrService } from '../configuration/ocr-service';
import { MindosInitialFiles } from '../presets/initial-files';
import { PrivilegedCommandService } from '../kernel/privileged-command-service';
import { createSessionSkillControls } from '@itookit/kernel-adapters';
import { ProjectSessions } from '../projects/project-sessions';
import { SessionLifecycleService } from '../session/session-lifecycle';
import { WorkbenchArchiveExporter } from '../projects/workbench-archive';
import { WorkbenchArchiveImporter } from '../projects/workbench-import';
import { exportSessionBundle } from '../session/session-bundle';
import { exportRemoteSession } from '../session/remote-session-export';
import { resolveProjectFavorite } from '../projects/favorites/routes';
import { manageRemoteSession } from '../session/remote-session-management';
import { ToolboxInventory } from '../configuration/toolbox-catalog';
import { ToolboxResources } from '../configuration/toolbox-resources';
import { listRemoteHarnessAgents } from '../projects/remote-agent-catalog';
import { conversationBranches } from '@itookit/piagent-driver';
import { createWorkbenchView } from './workbench-view';
import { openSessionView } from './session-view';
import { observeConnections } from './connection-observation';
import { readUiDocuments, writeUiDocuments } from './ui-documents';
import { ViewScope } from './view-scope';
import { taskDetails, taskEvents } from './task-view';
import type { ApplicationClient, ApplicationBackend, LocalApplicationServices, LocalBackendOptions, ToolboxView } from '@itookit/app-contracts/services';

export interface ApplicationViewOptions extends LocalBackendOptions { preload?: boolean }
/** Bind construction dependencies once, inside the host rather than across the UI port. */
export function createApplicationClient(services: LocalApplicationServices, options: ApplicationViewOptions = {}): ApplicationClient & { close(): Promise<void> } {
    const scope = new ViewScope(), backend = bindApplicationBackend(services, options, scope);
    return { services: { ...services, agentService: withConfigurationImport(services.agentService),
        llmDriver: withConfigurationImport(services.llmDriver), flowEngine: { engine: services.flowEngine.engine }, kernel: { kernel: services.kernel.kernel, toolCatalog: services.kernel.toolCatalog } },
        backend, close: () => scope.close() };
}
export function bindApplicationBackend(services: LocalApplicationServices, options: ApplicationViewOptions = {}, scope = new ViewScope()): ApplicationBackend {
    const { vfs, agentService, sessionRepository: repository, projects, kernel, commandBus } = services;
    const lifecycle = () => new SessionLifecycleService({ repository, kernel: kernel.kernel });
    return {
        navigationView: options => navigationView(vfs, options),
        warmNavigation: roots => warmNavigation(vfs, roots),
        workbenchView: async settings => {
            const view = await createWorkbenchView({ ...settings, repository, files: services.sessionFiles, kernel: kernel.kernel, projects }, options.preload);
            return { ...view, browser: await scope.own(view.browser),
                chat: settings?.chatControls ? { privilegedCommands: new PrivilegedCommandService(kernel.kernel, agentService),
                    sessionSkills: createSessionSkillControls(kernel.kernel, kernel.sessions) } : undefined,
                connections: projects?.remoteMounts ? await scope.own(observeConnections(projects.remoteMounts)) : undefined };
        },
        openSessionView: async id => scope.own(await openSessionView(services, id)),
        readUiDocuments: names => readUiDocuments(vfs, names),
        writeUiDocuments: documents => writeUiDocuments(vfs, documents),
        settings: sources => settingsService(services, sources, options, scope),
        ocr: async () => new OcrService(await vfs.openFileSystem('/etc'), agentService, kernel.llmService),
        initialFiles: async () => new MindosInitialFiles(commandBus, await vfs.openFileSystem('/home/admin/minds')),
        projectSessions: async () => projects?.sessions ?? new ProjectSessions(repository),
        toolboxView: skills => toolboxView(services, scope, skills),
        archiveExporter: async () => new WorkbenchArchiveExporter(projects, repository),
        archiveImporter: async () => new WorkbenchArchiveImporter(projects, await lifecycle(), repository),
        exportSession: (...args) => exportSessionBundle(repository, ...args),
        exportRemoteSession: (...args) => exportRemoteSession(projects, ...args),
        resolveFavorite: (folder, id) => resolveProjectFavorite(projects, repository, folder, id),
        manageRemoteSession: (...args) => manageRemoteSession(projects, ...args),
        conversationBranches: (folder, profile, session, settings) => conversationFamily(services, folder, profile, session, settings),
        taskDetails: (session, task) => taskDetails(kernel.kernel, session, task),
        taskEvents: (session, task, settings) => taskEvents(kernel.kernel, session, task, settings),
    };
}
async function toolboxView(services: LocalApplicationServices, scope: ViewScope, skills: import('@itookit/vfs-core').IFileSystem): Promise<ToolboxView> {
    const { agentService, kernel, vfs, projects } = services;
    const inventory = new ToolboxInventory(() => agentService.getMCPServers(), kernel.toolCatalog, agentService,
        () => agentService.listSystemPrompts(), () => listRemoteHarnessAgents(projects?.remoteMounts));
    const resources = new ViewScope(); await resources.own(inventory);
    try {
        await inventory.init();
        const agents = await resources.own(createFileSystemView({ viewId: 'toolbox:agents', mounts: [
            { mountId: 'local', at: '/', fs: await vfs.openFileSystem('/home/admin/agents'), access: 'rw' },
            { mountId: 'remote', at: '/@remote', fs: inventory.remoteAgentSource, access: 'ro' }] }));
        const toolbox = new ToolboxResources({ ...inventory.sources, agents, skills, flows: services.flowEngine.engine },
            agentService, services.commandBus, await vfs.openFileSystem('/etc'));
        return scope.own({ inventory, resources: toolbox, dispose: () => resources.close() });
    } catch (error) { await resources.close(); throw error; }
}
async function conversationFamily(services: LocalApplicationServices, folder: string, profile: string, session: string,
    options?: import('@itookit/vfs-core').OperationOptions) {
    const project = await services.projects.forFolder(folder), remote = services.projects.remoteMounts;
    if (!project || !remote) throw new FSError('ENOENT', 'Native project unavailable');
    const client = await remote.projectHarness(project.project.id, options ?? {});
    try {
        if (!client.inspect) throw new FSError('ECAPABILITY', 'Native inspection unavailable');
        const current = (await client.inspect(profile, session, options)).session;
        return await conversationBranches(client, profile, current, options ?? {});
    } finally { await client.close(); }
}

async function settingsService(services: LocalApplicationServices, sources: readonly import('@itookit/app-contracts/settings').SettingsWorkspaceSource[], options: ApplicationViewOptions, scope: ViewScope) {
    const service = new SettingsService(services.vfs, undefined, sources, options.snapshots?.(services.vfs));
    try { await service.init(); return await scope.own(service); }
    catch (error) { await service.dispose(); throw error; }
}
