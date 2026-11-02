import type {IAgentManagementService} from '@itookit/kernel-adapters/contracts';
import type {IFileSystem} from '@itookit/vfs-core';
import type {RemoteFileSourceProvider, ProjectRemoteMountService} from '../projects/remote-mounts';
import type {HarnessConnectionService} from '../projects/harness-connections';
import {publishManagedAgent} from '../configuration/managed-agent';
import {prepareWorktree} from '../projects/worktree-preparation';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import {requireValue} from '../kanban/validation';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/record-execution';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import {initializeWorkspaceMessages} from '../run/workspace-messages';
import preset from './kanban-development.json';

interface Options {fs: IFileSystem; agents: IAgentManagementService; connections: HarnessConnectionService;
    remote: ProjectRemoteMountService; provider: RemoteFileSourceProvider;
    projects: Pick<import('@itookit/app-contracts/services').ProjectService, 'get' | 'openWorkspace'>}
type Input = Parameters<NonNullable<PersonalKanbanAutomationOptions['prepareWork']>>[0];

/** Product preparation policy; generic Kanban only stores its opaque binding. */
export function developmentPreparation(options: Options): NonNullable<PersonalKanbanAutomationOptions['prepareWork']> {
    const journal = new KanbanAutomationJournal(options.fs);
    return async input => {
        requireValue(input.preparation.system === 'nestos-work-preparation' && input.preparation.id === 'git-worktree' && input.preparation.revision === '1', 'WORK_PREPARATION_UNSUPPORTED');
        requireValue(input.target.kind === 'agent', 'NATIVE_AGENT_REQUIRED');
        const source = await options.agents.getAgentRevision?.(input.target.id, input.target.version);
        requireValue(source?.target.digest === input.target.digest && source.definition.execution?.kind === 'harness', 'NATIVE_AGENT_REQUIRED');
        const selected = input.item.externalRefs?.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE) ?? [];
        requireValue(selected.length === 1, 'SINGLE_PROJECT_TASK_REQUIRED');
        const template = await options.connections.get(source.definition.execution.connectionId);
        requireValue(template?.connection && template.connection.enabled !== false, 'NATIVE_CONNECTION_REQUIRED');
        const directory = '_nestos/worktrees/' + input.dispatch.id;
        const nodeConnectionId = await workspace(options, journal, input, selected[0].id, template.connection.profileId, directory);
        const folder = await options.projects.get(selected[0].id), view = await options.projects.openWorkspace(folder.path);
        try {await initializeWorkspaceMessages(view.fs, '/workspace/' + directory + '/_nestos/kanban', {
            runId: input.item.externalRefs?.find(ref => ref.system === 'nestos-decision-run')?.id ?? input.dispatch.planId,
            itemId: input.item.id, attemptId: input.dispatch.id});} finally {await view.dispose();}
        const connection = {...template.connection, id: 'work-' + input.dispatch.id, projectId: selected[0].id, nodeConnectionId, directory};
        const existing = await options.connections.get(connection.id);
        if (existing) requireValue(JSON.stringify(existing.connection) === JSON.stringify(connection), 'WORK_CONNECTION_CHANGED');
        else await options.connections.save(connection, 0);
        const definition = {...source.definition, id: 'work-' + input.dispatch.id, name: input.item.title,
            config: {...source.definition.config, systemPromptId: undefined, systemPrompt: [source.definition.config.systemPrompt,
                ...(source.systemPrompt?.content ?? []), preset.instruction].filter(Boolean).join('\n\n')},
            execution: {kind: 'harness' as const, connectionId: connection.id}};
        return publishManagedAgent(options.agents, journal, definition);
    };
}

async function workspace(options: Options, journal: KanbanAutomationJournal, input: Input, projectId: string, profileId: string, directory: string): Promise<string> {
    const root = options.remote.list(projectId).find(mount => mount.at === '/');
    requireValue(root?.connectionId && root.serverProjectId && root.access === 'rw', 'REMOTE_WORKSPACE_REQUIRED');
    const harness = await options.remote.projectHarness(projectId, {requireRegistered: true});
    try {requireValue((await harness.profiles()).profiles.find(profile => profile.id === profileId)?.capabilities.workingDirectory, 'NATIVE_WORKING_DIRECTORY_UNSUPPORTED');}
    finally {await harness.close();}
    const connection = await options.remote.resolveConnection(root.connectionId), provider = options.provider;
    requireValue(provider.projects && provider.projectProcess && provider.capabilities, 'WORKSPACE_PROCESS_UNAVAILABLE');
    const client = provider.projects(connection);
    try {
        const project = await client.read(root.serverProjectId), caps = await provider.capabilities(connection);
        requireValue(project.revision === root.serverProjectRevision && caps.serverId === root.serverId && caps.processEpoch, 'WORKSPACE_BINDING_CHANGED');
        const process = await provider.projectProcess(connection, project, {serverId: caps.serverId, epoch: caps.processEpoch, cwd: '/workspace',
            mounts: [{alias: project.alias, path: project.path, at: '/workspace', access: project.access}, ...project.mounts]});
        try {await prepareWorktree(journal, input.dispatch.id, '/workspace/' + directory, process);}
        finally {await process.release();}
    } finally {await client.close();}
    return root.connectionId;
}
