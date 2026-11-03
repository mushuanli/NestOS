import {sha256HexSync} from '@itookit/common';
import {randomUUID} from '@itookit/common';
import {failure, type PromptJournal} from '../run/prompt-bundle';
import type {RemoteProcessHandle} from './remote-mounts';
import type {PreparedWorktree} from './worktree-preparation';

export interface WorktreeRepository {path: string; branch: string; baseCommit: string}
export async function gitWorkspace(process: RemoteProcessHandle, cwd: string, args: string[], allowFailure = false) {
    const result = await admittedGit(process, cwd, args);
    const codes: Record<string, string> = {submodule: 'MODULE_INITIALIZATION_FAILED', switch: 'MODULE_BRANCH_CREATION_FAILED',
        'ls-tree': 'MODULE_BASE_READ_FAILED', status: 'WORKSPACE_STATUS_FAILED', 'hash-object': 'DELIVERY_FILE_HASH_FAILED'};
    if (result.code !== 0 && !allowFailure) throw Object.assign(failure(codes[args[0]] ?? 'WORKSPACE_GIT_FAILED'), {stage: args[0], exitCode: result.code});
    return result;
}
/** A rejected admission ran no process; uncertain outcomes must never be replayed. */
async function admittedGit(process: RemoteProcessHandle, cwd: string, args: string[]) {
    for (let attempt = 0; ; attempt++) {
        try {return await process.nativeShell.exec('git', args, {cwd, timeoutMs: 120000});}
        catch (error) {
            const value = error as {code?: string; remoteCode?: string; outcome?: string};
            if (attempt >= 2 || (value.remoteCode ?? value.code) !== 'EBUSY' || value.outcome !== 'not-committed') throw error;
            await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
        }
    }
}

export async function prepareWorktreeModules(journal: PromptJournal, tree: PreparedWorktree, modules: string[], process: RemoteProcessHandle): Promise<WorktreeRepository[]> {
    const repositories: WorktreeRepository[] = [{path: '.', branch: tree.branch, baseCommit: tree.baseCommit}];
    for (const path of modules) repositories.push(await prepareModule(journal, tree, path, process));
    return repositories;
}
async function prepareModule(journal: PromptJournal, tree: PreparedWorktree, path: string, process: RemoteProcessHandle): Promise<WorktreeRepository> {
    const key = 'worktree-module:' + tree.id + ':' + path;
    type Entry = WorktreeRepository & {phase: 'prepared' | 'creating' | 'ready'; claim?: string};
    let saved = await journal.get<Entry>(key);
    if (!saved) {
        const entry = (await gitWorkspace(process, tree.directory, ['ls-tree', 'HEAD', '--', path])).stdout.trim();
        const match = /^160000 commit ([a-f0-9]{40,64})\t(.+)$/.exec(entry);
        if (match?.[2] !== path) throw failure('MODULE_NOT_REGISTERED');
        saved = await journal.update<Entry>(key, old => old ?? {path, branch: tree.branch, baseCommit: match[1], phase: 'prepared'});
    }
    if (saved.phase === 'prepared') {
        await initializeModule(process, tree.directory, path, saved.baseCommit);
        const state = await gitWorkspace(process, tree.directory + '/' + path, ['status', '--porcelain']);
        if (state.stdout.trim()) throw failure('MODULE_WORKTREE_DIRTY');
        const claim = randomUUID();
        saved = await journal.update<Entry>(key, old => old?.phase === 'prepared' ? {...old, phase: 'creating', claim} : old!);
        if (saved.claim === claim) await gitWorkspace(process, tree.directory + '/' + path, ['switch', '-c', saved.branch, saved.baseCommit]);
    }
    const current = (await gitWorkspace(process, tree.directory + '/' + path, ['branch', '--show-current'])).stdout.trim();
    if (current !== saved.branch) throw failure('MODULE_BRANCH_UNCONFIRMED');
    await journal.update<Entry>(key, old => ({...old!, phase: 'ready'}));
    return {path, branch: saved.branch, baseCommit: saved.baseCommit};
}

export interface RepositoryEvidence extends WorktreeRepository {head: string; dirty: boolean; changesDigest: string}
/** Compare Git facts with the frozen policy; model output never grants commit authority. */
export async function verifyWorktreeDelivery(process: RemoteProcessHandle, directory: string, repositories: WorktreeRepository[], commit: 'changes' | 'worktree', available: WorktreeRepository[] = []): Promise<RepositoryEvidence[]> {
    const changed = await changedModules(process, directory, repositories[0].baseCommit);
    const selected = [...repositories, ...available.filter(row => changed.includes(row.path) && !repositories.some(prepared => prepared.path === row.path))];
    if (changed.some(path => !selected.some(row => row.path === path))) throw failure('UNDECLARED_MODULE_CHANGED');
    const evidence = [];
    for (const repository of selected) {
        const cwd = repository.path === '.' ? directory : directory + '/' + repository.path;
        const branch = (await gitWorkspace(process, cwd, ['branch', '--show-current'])).stdout.trim();
        const head = (await gitWorkspace(process, cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
        if (branch !== repository.branch) throw failure('DELIVERY_BRANCH_CHANGED');
        if (commit === 'changes' && head !== repository.baseCommit) throw failure('UNAUTHORIZED_COMMIT');
        if (commit === 'worktree' && (await gitWorkspace(process, cwd, ['merge-base', '--is-ancestor', repository.baseCommit, head], true)).code !== 0)
            throw failure('DELIVERY_BASE_CHANGED');
        const dirty = !!(await gitWorkspace(process, cwd, ['status', '--porcelain', '--ignore-submodules=none', '--untracked-files=normal'])).stdout.trim();
        if (commit === 'worktree' && dirty) throw failure('DELIVERY_UNCOMMITTED_CHANGES');
        evidence.push({...repository, head, dirty, changesDigest: await changesDigest(process, cwd)});
    }
    return evidence;
}
async function changedModules(process: RemoteProcessHandle, directory: string, baseCommit: string): Promise<string[]> {
    const parts = (await gitWorkspace(process, directory, ['diff', '--raw', '--ignore-submodules=none', '--no-renames', '-z', baseCommit, '--'])).stdout.split('\0');
    const paths = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
        if (/^:(?:160000 [0-9]{6}|[0-9]{6} 160000) /.test(parts[index])) paths.push(parts[index + 1]);
    }
    const modules = await trackedModulePaths(process,directory);
    const status = (await gitWorkspace(process, directory, ['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=none'])).stdout;
    for (const entry of status.split('\0')) if (modules.has(entry.slice(3))) paths.push(entry.slice(3));
    return [...new Set(paths)];
}
export async function availableWorktreeModules(process: RemoteProcessHandle, tree: PreparedWorktree): Promise<WorktreeRepository[]> {
    const paths=(await moduleBindings(process,tree.directory)).map(binding=>binding.path);
    if(!paths.length)return [];
    const entries = (await gitWorkspace(process, tree.directory, ['ls-tree', '-z', tree.baseCommit, '--', ...paths])).stdout.split('\0');
    const modules = entries.flatMap(entry => {
        const match = /^160000 commit ([a-f0-9]{40,64})\t(.+)$/.exec(entry);
        return match ? [{path: match[2], baseCommit: match[1], branch: tree.branch}] : [];
    });
    if (modules.length > 256) throw failure('WORKSPACE_MODULE_LIMIT');
    return modules;
}

async function changesDigest(process: RemoteProcessHandle, cwd: string): Promise<string> {
    const changed = (await gitWorkspace(process, cwd, ['diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', 'HEAD', '--'])).stdout;
    const untracked = (await gitWorkspace(process, cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
    const modules = await trackedModulePaths(process,cwd);
    const paths = [...new Set((changed + untracked).split('\0').filter(path => path && !modules.has(path)))].sort();
    if (paths.length > 1000) throw failure('DELIVERY_FILE_LIMIT');
    const hashes = paths.length ? (await gitWorkspace(process, cwd, ['hash-object', '--', ...paths])).stdout : '';
    const delta = (await gitWorkspace(process, cwd, ['diff', '--raw', '-z', 'HEAD', '--'])).stdout;
    return sha256HexSync(JSON.stringify({paths, hashes, delta}));
}

/** Clone local objects independently so native namespaces never depend on absolute alternates. */
async function initializeModule(process:RemoteProcessHandle,directory:string,path:string,commit:string):Promise<void> {
    const source='/workspace/'+path;
    const available=await gitWorkspace(process,source,['cat-file','-e',commit+'^{commit}'],true);
    if(available.code!==0) {await gitWorkspace(process,directory,['submodule','update','--init','--',path]);return;}
    const binding=(await moduleBindings(process,directory)).find(binding=>binding.path===path);
    if(!binding)throw failure('MODULE_NOT_REGISTERED');
    await gitWorkspace(process,directory,['-c','protocol.file.allow=always','-c',binding.key.slice(0,-5)+'.url='+source,
        'submodule','update','--init','--',path]);
}

async function moduleBindings(process:RemoteProcessHandle,directory:string):Promise<Array<{key:string;path:string}>> {
    const result=await gitWorkspace(process,directory,['config','--file','.gitmodules','--get-regexp','^submodule\\..*\\.path$'],true);
    if(result.code===1)return [];
    if(result.code!==0)throw failure('MODULE_BASE_READ_FAILED');
    const bindings=result.stdout.split('\n').filter(Boolean).map(line=>({key:line.slice(0,line.indexOf(' ')),path:line.slice(line.indexOf(' ')+1)}));
    if(bindings.length>256)throw failure('WORKSPACE_MODULE_LIMIT');
    return bindings;
}
async function trackedModulePaths(process:RemoteProcessHandle,directory:string):Promise<Set<string>> {
    const paths=(await moduleBindings(process,directory)).map(binding=>binding.path);
    if(!paths.length)return new Set();
    const index=(await gitWorkspace(process,directory,['ls-files','--stage','-z','--',...paths])).stdout;
    return new Set(index.split('\0').filter(entry=>entry.startsWith('160000 ')).map(entry=>entry.slice(entry.indexOf('\t')+1)));
}
