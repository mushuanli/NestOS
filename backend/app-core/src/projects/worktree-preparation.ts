import {FSError} from '@itookit/vfs-core';
import {randomUUID} from '@itookit/common';
import type {RemoteProcessHandle} from './remote-mounts';

export interface PreparedWorktree {id: string; directory: string; branch: string; baseCommit: string; phase: 'prepared' | 'creating' | 'ready'; claim?: string}
interface Journal {get<T>(key: string): Promise<T | undefined>; update<T>(key: string, change: (old: T | undefined) => T): Promise<T>}

/** Relative Git metadata survives the process and native-session namespace change. */
export async function prepareWorktree(journal: Journal, id: string, directory: string, process: RemoteProcessHandle): Promise<PreparedWorktree> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !directory.startsWith('/workspace/') || directory.split('/').some(part => part === '..' || part === '.'))
        throw new FSError('EINVAL', 'Invalid worktree identity');
    const key = 'worktree:' + id;
    let saved = await journal.get<PreparedWorktree>(key);
    if (saved && saved.directory !== directory) throw new FSError('ECONFLICT', 'Worktree directory changed');
    if (!saved) {
        const baseCommit = (await git(process, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
        if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new FSError('EIO', 'Invalid repository base commit');
        saved = await journal.update<PreparedWorktree>(key, previous => previous ?? {id, directory, baseCommit, branch: 'work/' + id, phase: 'prepared'});
    }
    if (saved.phase === 'prepared') {
        const claim = randomUUID();
        saved = await journal.update<PreparedWorktree>(key, previous => previous!.phase === 'prepared' ? {...previous!, phase: 'creating', claim} : previous!);
        if (saved.claim === claim) await git(process, ['worktree', 'add', '--relative-paths', '-b', saved.branch, saved.directory, saved.baseCommit]);
    }
    const listing = await git(process, ['worktree', 'list', '--porcelain']);
    const entry = listing.split('\n\n').find(entry => entry.split('\n').includes('worktree ' + saved!.directory));
    if (!entry?.split('\n').includes('branch refs/heads/' + saved.branch)) throw new FSError('ECONFLICT', 'Worktree creation is unconfirmed; original intent retained');
    return journal.update<PreparedWorktree>(key, previous => ({...previous!, phase: 'ready'}));
}

async function git(process: RemoteProcessHandle, args: string[]): Promise<string> {
    const result = await process.nativeShell.exec('git', args, {cwd: '/workspace', timeoutMs: 120000});
    if (result.code !== 0) throw Object.assign(new Error('Git worktree operation failed'), {
        code: args[0] === 'rev-parse' ? 'GIT_BASE_READ_FAILED' : args[1] === 'add' ? 'GIT_WORKTREE_CREATE_FAILED' : 'GIT_WORKTREE_QUERY_FAILED',
        stage: args[0], exitCode: result.code});
    return result.stdout;
}
