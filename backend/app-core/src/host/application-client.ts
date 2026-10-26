import {submitSession, prepareSessionBranch} from '../session/submit-session';
import { navigationView, warmNavigation } from './navigation-view';
import { createMindosProviderTemplates } from '@itookit/kernel-adapters/llm/presets';
import { createFileSystemView, FSError } from '@itookit/vfs-core';
import { createToolboxFiles } from '../configuration/toolbox-files';
import { withConfigurationImport } from '../configuration/configuration-import';
import { SettingsService } from '../settings/SettingsService';
import { OcrService } from '../configuration/ocr-service';
import { MindosInitialFiles } from '../presets/initial-files';
import { createMindosFlowDrawers } from '../presets/flow-library';
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
import { unmountRemoteProject } from '../projects/unmount-project';
import { ToolboxInventory } from '../configuration/toolbox-catalog';
import { SkillsEngine } from '../configuration/skills-files';
import { ToolboxResources } from '../configuration/toolbox-resources';
import { listRemoteHarnessAgents } from '../projects/remote-agent-catalog';
import { conversationBranches } from '@itookit/mindos-node-driver';
import { prepareWorkbenchView } from './workbench-view';
import { openSessionView } from './session-view';
import { observeConnections } from './connection-observation';
import { readUiDocuments, writeUiDocuments } from './ui-documents';
import { ViewScope } from './view-scope';
import { taskDetails, taskEvents, sessionTasks } from './task-view';
import { createSessionDraft } from '../session/create-session-draft';
import { createChatConfigurationView } from '../configuration/chat-configuration';
import { taskAttachment } from './task-attachment';
import {openView} from './open-view';
import type { ApplicationClient, ApplicationBackend, LocalApplicationServices, LocalBackendOptions, ToolboxView } from '@itookit/app-contracts/services';

export interface ApplicationViewOptions extends LocalBackendOptions { preload?: boolean }
/** Bind construction dependencies once, inside the host rather than across the UI port. */
export function createApplicationClient(services: LocalApplicationServices, options: ApplicationViewOptions = {}): ApplicationClient & { close(): Promise<void> } {
    const scope = new ViewScope(), backend = bindApplicationBackend(services, options, scope);
    const { acquireConversation: _acquireConversation, ...publicServices } = services;
    return { services: { ...publicServices, agentService: withConfigurationImport(services.agentService),
        llmDriver: withConfigurationImport(services.llmDriver), flowEngine: { engine: services.flowEngine.engine }, kernel: { kernel: services.kernel.kernel, toolCatalog: services.kernel.toolCatalog } },
        backend, close: () => scope.close() };
}
export function bindApplicationBackend(services: LocalApplicationServices, options: ApplicationViewOptions = {}, scope = new ViewScope()): ApplicationBackend {
    const { vfs, agentService, sessionRepository: repository, projects, kernel, commandBus } = services;
    const lifecycle = () => new SessionLifecycleService({ repository, kernel: kernel.kernel });
    let opening = false;
    const backend: ApplicationBackend = {
        openView: async request => {
            if (opening) throw new FSError('EBUSY', 'A view is already opening');
            opening = true;
            try { return await scope.own(await openView(services, backend, request)); }
            finally { opening = false; }
        },
        prepareSessionBranch: request => prepareSessionBranch(services, request),
        submitSession: request => submitSession(services, request),
        createSessionDraft: request => createSessionDraft(projects, repository, request),
        navigationView: options => navigationView(vfs, options),
        warmNavigation: roots => warmNavigation(vfs, roots),
        workbenchView: async settings => {
            const owned = new ViewScope();
            try {
                const view = await prepareWorkbenchView({ ...settings, repository, files: services.sessionFiles, kernel: kernel.kernel, projects }, !!options.preload, settings?.initialNavigation !== false,
                    settings?.initialSessionId ? () => prepareInitialSession(services, settings.initialSessionId!) : undefined);
                const browser = await owned.own(view.browser);
                const initialSession = view.initialSession ? await owned.own(view.initialSession) : undefined;
                const chat = settings?.chatControls ? {privilegedCommands: new PrivilegedCommandService(kernel.kernel, agentService),
                    sessionSkills: createSessionSkillControls(kernel.kernel, kernel.sessions),
                    configuration: options.preload ? await owned.own(await createChatConfigurationView(agentService)) : undefined} : undefined;
                const connections = projects?.remoteMounts ? await owned.own(observeConnections(projects.remoteMounts)) : undefined;
                await scope.own({dispose: () => owned.close()});
                return {...view, browser, initialSession, chat, connections};
            } catch (error) {
                try {await owned.close();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Workbench preparation cleanup failed');}
                throw error;
            }
        },
        openSessionView: async id => scope.own(await openSessionView(services, id)),
        readUiDocuments: names => readUiDocuments(vfs, names),
        writeUiDocuments: documents => writeUiDocuments(vfs, documents),
        settings: sources => settingsService(services, sources, options, scope),
        ocr: async () => new OcrService(await vfs.openFileSystem('/etc'), agentService, kernel.llmService),
        initialFiles: async () => new MindosInitialFiles(commandBus, await vfs.openFileSystem('/home/admin/minds'), services.flowInstallations),
        projectSessions: async () => projects?.sessions ?? new ProjectSessions(repository),
        skillsFiles: () => scope.own(new SkillsEngine(agentService)),
        toolboxView: () => toolboxView(services, scope),
        archiveExporter: async () => new WorkbenchArchiveExporter(projects, repository),
        archiveImporter: async () => new WorkbenchArchiveImporter(projects, await lifecycle(), repository),
        exportSession: (...args) => exportSessionBundle(repository, ...args),
        exportRemoteSession: (...args) => exportRemoteSession(projects, ...args),
        resolveFavorite: (folder, id) => resolveProjectFavorite(projects, repository, folder, id),
        manageRemoteSession: (...args) => manageRemoteSession(projects, ...args),
        unmountProject: id => unmountRemoteProject(projects, lifecycle(), id),
        conversationBranches: (folder, profile, session, settings) => conversationFamily(services, folder, profile, session, settings),
        taskDetails: (session, task) => taskDetails(kernel.kernel, session, task),
        taskAttachment: (session, key) => taskAttachment(services, session, key),
        sessionTasks: (session, settings) => sessionTasks(kernel.kernel, session, settings),
        taskEvents: (session, task, settings) => taskEvents(kernel.kernel, session, task, settings),
    };
    return backend;
}
async function prepareInitialSession(services: LocalApplicationServices, id: string) {
    try { return await openSessionView(services, id); }
    catch (error) {
        if (isMissingSession(error)) return undefined;
        throw error;
    }
}
function isMissingSession(error: unknown): boolean {
    const visited = new Set<unknown>();
    while (error instanceof Error && !visited.has(error)) {
        if (error instanceof FSError && error.code === 'ENOENT') return true;
        visited.add(error); error = error.cause;
    }
    return false;
}
async function toolboxView(services: LocalApplicationServices, scope: ViewScope): Promise<ToolboxView> {
    const { agentService, kernel, vfs, projects } = services;
    const inventory = new ToolboxInventory(() => agentService.getMCPServers(), kernel.toolCatalog, agentService,
        () => agentService.listSystemPrompts(), () => listRemoteHarnessAgents(projects?.remoteMounts));
    const resources = new ViewScope(); await resources.own(inventory);
    try {
        await inventory.init();
        const agents = await resources.own(createFileSystemView({ viewId: 'toolbox:agents', mounts: [
            { mountId: 'local', at: '/', fs: await vfs.openFileSystem('/home/admin/agents'), access: 'rw' },
            { mountId: 'remote', at: '/@remote', fs: inventory.remoteAgentSource, access: 'ro' }] }));
        const skills = await resources.own(new SkillsEngine(agentService));
        const toolbox = new ToolboxResources({ ...inventory.sources, agents, skills, flows: services.flowEngine.engine },
            agentService, services.commandBus, await vfs.openFileSystem('/etc'), inventory, createMindosFlowDrawers(), createMindosProviderTemplates(), {toolPackages: services.toolPackages, flowInstallations: services.flowInstallations});
        const files = await resources.own(createToolboxFiles(toolbox.sources));
        const initial = await toolbox.navigation(false);
        return scope.own({ inventory, resources: toolbox, files, initial, dispose: () => resources.close() });
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
