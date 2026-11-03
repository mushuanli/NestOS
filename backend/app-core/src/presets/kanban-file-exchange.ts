import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import type {Kernel} from '@itookit/durable-kernel';
import type {KanbanService} from '@itookit/kanban/contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../projects/remote-mounts';
import type {KanbanAutomationJournal} from '../kanban/automation-journal';
import type {sessionSubmission, SessionSubmissionObservation} from '../run/session-submission';
import {failure} from '../run/prompt-bundle';
import {advanceFileExchange} from '../run/file-exchange';
import {prepareFileContinuation} from '../run/file-session-continuation';
import {resolveCommitRequest} from './kanban-commit-query';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
export interface DevelopmentExchangeOptions {
    projects: Pick<ProjectService, 'get' | 'openWorkspace'>; remote: ProjectRemoteMountService; provider: RemoteFileSourceProvider;
    kernel: Pick<Kernel, 'inspectSession' | 'sessionActivity'>; journal: KanbanAutomationJournal;
    submission: ReturnType<typeof sessionSubmission>;
}
/** Product context resolution plugs into a generic, file-only request/response mechanism. */
export async function developmentFileExchange(options: DevelopmentExchangeOptions, input: {id: string; record: DevelopmentWorkspaceRecord;
    service: KanbanService; base: SubmissionRequest; observation: SessionSubmissionObservation; targetHead?: string;
    finalPublished?: boolean | (() => Promise<boolean>); resultFile?: string; beforeResume?(): Promise<void>; report?(stage: string, id: string, code?: string): Promise<void>}): Promise<SessionSubmissionObservation> {
    const directory = input.record.communicationDirectory ?? input.record.directory + '/_nestos/kanban';
    const folder = await options.projects.get(input.record.projectId), view = await options.projects.openWorkspace(folder.path);
    try {
        if (!await view.fs.driver.exists(directory + '/exchange.json')) {
            if (input.record.exchangeVersion === 2) throw failure('FILE_EXCHANGE_PROTOCOL_MISSING');
            return input.observation;
        }
        return await advanceFileExchange({id: input.id, directory, scopeId: input.id, fs: view.fs, journal: options.journal,
            submission: options.submission, report: input.report,
            finalPublished: input.finalPublished ?? (input.resultFile ? () => view.fs.driver.exists(directory + '/' + input.resultFile) : false),
            resolve: request => developmentWorkspace(options.remote, options.provider, input.record.projectId,
                process => resolveCommitRequest({...options, service: input.service, record: input.record, targetHead: input.targetHead, process}, request)),
            prepare: async (id, paths) => {await input.beforeResume?.(); return prepareFileContinuation({kernel: options.kernel, base: input.base, sessionId: input.observation.sessionId,
                connectionId: 'work-' + (input.record.worktreeId ?? input.id), id, paths: paths.map(reply => ({...reply, path: reply.path.replace('/workspace/', '')}))});},
        }, input.observation);
    } finally {await view.dispose();}
}

export function developmentWorkExchange(options: DevelopmentExchangeOptions & {calls: Pick<import('@itookit/llm-session').IndependentCallService, 'list'>}) {
    return async (input: {id: string; record: DevelopmentWorkspaceRecord; service: KanbanService;
        observation: import('@itookit/kanban/execution').KanbanExecutionObservation; finalPublished?: boolean | (() => Promise<boolean>); report?(stage: string, id: string, code?: string): Promise<void>}) => {
        if (input.record.exchangeVersion !== 2) return input.observation;
        const sessionId = input.observation.executionSessionId;
        if (!sessionId) return input.observation;
        const original = (await options.calls.list({sessionId: input.record.worktreeId ?? input.id})).find(row => row.receipt.executionSessionId === sessionId);
        if (!original) throw Object.assign(new Error('Original Session unavailable'), {code: 'FILE_EXCHANGE_ORIGIN_UNAVAILABLE'});
        const row = await developmentFileExchange(options, {...input, base: original.input.request,
            observation: {sessionId, outcome: input.observation.outcome, code: input.observation.code}});
        return {...input.observation, outcome: row.outcome, code: row.code, outputs: row.outcome === 'succeeded' ? input.observation.outputs : undefined};
    };
}
