import {randomUUID, sha256HexSync} from '@itookit/common';
import type {PromptJournal} from '../run/prompt-bundle';
import {failure} from '../run/prompt-bundle';
import {gitWorkspace, type RepositoryEvidence} from '../projects/worktree-modules';
import type {RemoteProcessHandle} from '../projects/remote-mounts';
export interface CommitContext {
    schema: 'nestos.commit-context/1'; scopeId: string; projectId: string; boardId: string; itemId: string;
    itemRevision: number; executionId: string; digest: string; input: unknown; trailers: string;
}
export async function freezeCommitContext(journal: PromptJournal, input: {projectId: string; boardId: string; itemId: string; itemRevision: number; executionId: string; context: unknown}): Promise<CommitContext> {
    const key = 'development-commit-context:' + input.executionId, old = await journal.get<CommitContext>(key);
    if (old) {
        if (old.projectId !== input.projectId || old.boardId !== input.boardId || old.itemId !== input.itemId) throw failure('COMMIT_CONTEXT_SCOPE_CHANGED');
        await journal.update<CommitContext>('commit-context:' + old.digest, previous => previous ?? old); return old;}
    if ([input.projectId, input.boardId, input.itemId, input.executionId].some(value => !value || /[\r\n]/.test(value))) throw failure('COMMIT_CONTEXT_INVALID');
    const scopeId = await journal.update<string>('kanban-context-scope', value => value ?? randomUUID());
    const value = {schema: 'nestos.commit-context/1' as const, scopeId, projectId: input.projectId, boardId: input.boardId,
        itemId: input.itemId, itemRevision: input.itemRevision, executionId: input.executionId, input: input.context};
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 49152) throw failure('COMMIT_CONTEXT_LIMIT');
    const digest = sha256HexSync(JSON.stringify(value));
    const trailers = Object.entries({'NestOS-Scope': scopeId, 'NestOS-Board': input.boardId, 'NestOS-Task': input.itemId,
        'NestOS-Execution': input.executionId, 'NestOS-Context': 'sha256:' + digest}).map(([key, value]) => key + ': ' + value).join('\n') + '\n';
    const saved = await journal.update<CommitContext>(key, previous => previous ?? {...value, digest, trailers});
    await journal.update<CommitContext>('commit-context:' + saved.digest, previous => previous ?? saved);
    return saved;
}
export function parseCommitTrailers(text: string): Record<string, string> {
    const result: Record<string, string> = Object.create(null);
    for (const line of text.split('\n')) {
        const match = /^(NestOS-(?:Scope|Board|Task|Execution|Context)): (.+)$/.exec(line.trim());
        if (match) {if (Object.hasOwn(result, match[1])) throw failure('COMMIT_TRAILERS_AMBIGUOUS'); result[match[1]] = match[2];}
    }
    return result;
}
export async function verifyCommitContexts(process: RemoteProcessHandle, directory: string, repositories: RepositoryEvidence[], context: CommitContext): Promise<Array<{repository: string; commits: string[]}>> {
    const records = [];
    for (const repo of repositories) {
        const cwd = repo.path === '.' ? directory : directory + '/' + repo.path;
        const text = (await gitWorkspace(process, cwd, ['log', '--max-count=257', '--format=%H%x00%(trailers:only,unfold)%x00', repo.baseCommit + '..' + repo.head, '--'])).stdout;
        const parts = text.split('\0'), commits: string[] = [];
        for (let index = 0; index + 1 < parts.length; index += 2) {
            const sha = parts[index].trim(); if (!sha) continue;
            const actual = parseCommitTrailers(parts[index + 1]);
            for (const [key, value] of Object.entries(parseCommitTrailers(context.trailers))) if (actual[key] !== value) throw failure('COMMIT_TASK_CONTEXT_MISMATCH');
            if (!/^[a-f0-9]{40,64}$/.test(sha)) throw failure('COMMIT_CONTEXT_INVALID'); commits.push(sha);
        }
        if (commits.length > 256) throw failure('COMMIT_CONTEXT_LIMIT');
        records.push({repository: repo.path, commits});
    }
    return records;
}
