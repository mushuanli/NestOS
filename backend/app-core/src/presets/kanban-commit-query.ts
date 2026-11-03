import {sha256HexSync} from '@itookit/common';
import type {KanbanService, KanbanItem} from '@itookit/kanban/contracts';
import type {PromptJournal} from '../run/prompt-bundle';
import {failure} from '../run/prompt-bundle';
import type {FileRequest} from '../run/file-exchange-protocol';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {parseCommitTrailers, type CommitContext} from './kanban-commit-context';
import {gitWorkspace} from '../projects/worktree-modules';
import type {RemoteProcessHandle} from '../projects/remote-mounts';
export interface CommitQueryOptions {journal: PromptJournal; service: KanbanService; record: DevelopmentWorkspaceRecord; process: RemoteProcessHandle; targetHead?: string}
const queryFailure = (code: string) => Object.assign(failure(code), {fileResponse: true});
export async function resolveCommitRequest(options: CommitQueryOptions, request: FileRequest): Promise<unknown> {
    const {repository, commits, include} = request.params;
    if (request.method !== 'kanban.context.resolve') throw queryFailure('FILE_EXCHANGE_METHOD_UNSUPPORTED');
    if (typeof repository !== 'string' || !Array.isArray(commits) || !commits.length || commits.length > 16
        || commits.some(sha => typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(sha))
        || include !== undefined && (!Array.isArray(include) || include.some(field => !['task', 'decisions', 'acceptance'].includes(field)))) throw queryFailure('COMMIT_QUERY_INVALID');
    return resolveCommits(options, repository, [...new Set(commits as string[])], include as string[] | undefined);
}
export async function preloadCommitContexts(options: CommitQueryOptions): Promise<unknown> {
    const {source, target} = await repositoryHeads(options, '.');
    const commits = (await gitWorkspace(options.process, options.record.directory, ['log', '--max-count=17', '--format=%H', source + '...' + target, '--'])).stdout.trim().split('\n').filter(Boolean);
    return {...await resolveCommits(options, '.', commits.slice(0, 16)), truncated: commits.length > 16};
}
async function repositoryHeads(options: CommitQueryOptions, repository: string): Promise<{cwd: string; source: string; target: string}> {
    if (repository !== '.' && ![...options.record.repositories, ...options.record.availableRepositories].some(row => row.path === repository)) throw queryFailure('COMMIT_QUERY_REPOSITORY_FORBIDDEN');
    const cwd = repository === '.' ? options.record.directory : options.record.directory + '/' + repository;
    const source = (await gitWorkspace(options.process, cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    let target = options.targetHead ?? (await gitWorkspace(options.process, '/workspace', ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    if (repository !== '.') {
        const entry = (await gitWorkspace(options.process, '/workspace', ['ls-tree', target, '--', repository])).stdout.trim();
        const match = /^160000 commit ([a-f0-9]{40,64})\t/.exec(entry); if (!match) throw queryFailure('COMMIT_QUERY_REPOSITORY_FORBIDDEN'); target = match[1];
    }
    return {cwd, source, target};
}
async function resolveCommits(options: CommitQueryOptions, repository: string, commits: string[], include = ['task', 'decisions', 'acceptance']) {
    const {cwd, source, target} = await repositoryHeads(options, repository), contexts: unknown[] = [], unresolved: Array<{commit: string; code: string}> = [];
    let size = 0;
    for (const commit of commits) {
        const reachable = (await gitWorkspace(options.process, cwd, ['merge-base', '--is-ancestor', commit, source], true)).code === 0
            || (await gitWorkspace(options.process, cwd, ['merge-base', '--is-ancestor', commit, target], true)).code === 0;
        if (!reachable) {unresolved.push({commit, code: 'COMMIT_NOT_REACHABLE'}); continue;}
        const text = (await gitWorkspace(options.process, cwd, ['show', '-s', '--format=%(trailers:only,unfold)', commit, '--'])).stdout;
        let trailers: Record<string, string>; try {trailers = parseCommitTrailers(text);} catch {unresolved.push({commit, code: 'COMMIT_TRAILERS_AMBIGUOUS'}); continue;}
        const digest = trailers['NestOS-Context']?.match(/^sha256:([a-f0-9]{64})$/)?.[1], saved = digest ? await options.journal.get<CommitContext>('commit-context:' + digest) : undefined;
        if (!saved || saved.scopeId !== await options.journal.get('kanban-context-scope') || saved.projectId !== options.record.projectId
            || saved.scopeId !== trailers['NestOS-Scope'] || saved.boardId !== trailers['NestOS-Board'] || saved.itemId !== trailers['NestOS-Task']
            || saved.executionId !== trailers['NestOS-Execution'] || saved.digest !== digest) {unresolved.push({commit, code: 'COMMIT_CONTEXT_UNAVAILABLE'}); continue;}
        const {digest: storedDigest, trailers: _trailers, ...body} = saved;
        if (sha256HexSync(JSON.stringify(body)) !== storedDigest) throw failure('COMMIT_CONTEXT_INTEGRITY_INVALID');
        const value = {commit, repository, contextDigest: saved.digest, historical: selectHistorical(saved.input, include), current: await currentContext(options, saved, include)};
        const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if (size + bytes > 49152) {unresolved.push({commit, code: 'COMMIT_CONTEXT_LIMIT'}); continue;}
        size += bytes; contexts.push(value);
    }
    return {sourceHead: source, targetHead: target, contexts, unresolved};
}
async function currentContext(options: CommitQueryOptions, saved: CommitContext, include: string[]): Promise<unknown> {
    let item: KanbanItem;
    try {item = (await options.service.item(saved.boardId, saved.itemId)).item;}
    catch (error) {if (['ITEM_NOT_FOUND', 'BOARD_NOT_FOUND'].includes((error as {code?: string})?.code ?? '')) return {unavailable: true}; throw error;}
    const decision = (saved.input as {decision?: {sourceBoardId: string; recordId: string}})?.decision;
    let record: unknown;
    if (decision && include.includes('decisions')) {try {record = await options.service.record(decision.sourceBoardId, decision.recordId);}
        catch (error) {if (!['RECORD_NOT_FOUND', 'BOARD_NOT_FOUND'].includes((error as {code: string}).code)) throw error;}}
    return selectHistorical({task: {id: item.id, revision: item.revision, status: item.status, title: item.title, responsibility: item.responsibility, acceptance: item.acceptance}, decision: record ?? null}, include);
}

function selectHistorical(value: unknown, include: string[]): unknown {
    const context = value as {board?: unknown; task?: Record<string, unknown>; decision?: unknown};
    const {acceptance, ...task} = context?.task ?? {};
    return {...(context?.board ? {board: context.board} : {}),
        ...(include.includes('task') || include.includes('acceptance') ? {task: {
            ...(include.includes('task') ? task : {id: task.id, revision: task.revision}),
            ...(include.includes('acceptance') ? {acceptance} : {}),
        }} : {}), ...(include.includes('decisions') ? {decision: context?.decision ?? null} : {})};
}
