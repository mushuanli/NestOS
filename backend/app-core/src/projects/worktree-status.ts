import {sha256HexSync} from '@itookit/common';
import {gitWorkspace} from './worktree-modules';
import type {RemoteProcessHandle} from './remote-mounts';
import type {PreparedWorktree} from './worktree-preparation';
import {requireValue} from '../kanban/validation';

export interface WorktreeStatus {
    exists: boolean; branch: string; head?: string; targetBranch: string; targetHead: string;
    dirty: boolean; unmerged: boolean; initializedModules: boolean; ignoredFiles: number; version: string;
}
/** Check actual repository facts; task completion cannot substitute for integration. */
export async function inspectWorktree(process: RemoteProcessHandle, tree: PreparedWorktree, managedDirectory?: string): Promise<WorktreeStatus> {
    requireValue(/^[\w-]{1,128}$/.test(tree.id) && tree.directory.startsWith('/workspace/') && !tree.directory.split('/').some(part => part === '..' || part === '.'), 'WORKTREE_SCOPE_INVALID');
    const [listing, targetBranch, targetHead] = await queries(process, '/workspace', [
        ['worktree', 'list', '--porcelain'], ['symbolic-ref', '--quiet', '--short', 'HEAD'], ['rev-parse', '--verify', 'HEAD^{commit}']]);
    const entry = listing.split('\n\n').find(row => row.split('\n').includes('worktree ' + tree.directory));
    const base = {exists: !!entry, branch: tree.branch, targetBranch: targetBranch.trim(), targetHead: targetHead.trim()};
    if (!entry) return status({...base, dirty: false, unmerged: true, initializedModules: false, ignoredFiles: 0});
    requireValue(entry.split('\n').includes('branch refs/heads/' + tree.branch), 'WORKTREE_BRANCH_CHANGED');
    const [head, changes, ignored, modules] = await queries(process, tree.directory, [
        ['rev-parse', '--verify', 'HEAD^{commit}'], ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'],
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z', '--', '.',
            ...(managedDirectory ? [':(exclude)' + managedDirectory + '**'] : [])], ['submodule', 'status']]);
    const merged = await gitWorkspace(process, '/workspace', ['merge-base', '--is-ancestor', head.trim(), base.targetHead], true);
    requireValue(merged.code === 0 || merged.code === 1, 'WORKTREE_INTEGRATION_UNKNOWN');
    return status({...base, head: head.trim(), dirty: !!changes, unmerged: merged.code === 1,
        initializedModules: modules.split('\n').some(line => line && !line.startsWith('-')),
        ignoredFiles: ignored.split('\0').filter(path => path && !(managedDirectory && path.startsWith(managedDirectory))).length});
}
function status(value: Omit<WorktreeStatus, 'version'>): WorktreeStatus {return {...value, version: sha256HexSync(JSON.stringify(value))};}
async function queries(process: RemoteProcessHandle, cwd: string, args: string[][]): Promise<string[]> {
    const rows: string[] = [];
    for (const command of args) rows.push((await gitWorkspace(process, cwd, command)).stdout);
    return rows;
}
export function worktreeBlockers(state: WorktreeStatus): string[] {
    return [!state.exists && 'WORKTREE_MISSING', state.dirty && 'WORKTREE_DIRTY', state.unmerged && 'WORKTREE_NOT_INTEGRATED',
        state.initializedModules && 'WORKTREE_INITIALIZED_MODULES', state.ignoredFiles > 0 && 'WORKTREE_UNTRACKED_IGNORED'].filter((value): value is string => !!value);
}
