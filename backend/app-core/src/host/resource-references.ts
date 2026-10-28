import {createModuleLogger, randomUUID, sha256Hex} from '@itookit/common';
import {ResourceCommand, parseResourceReference, formatResourceReference, type ResourceScope, type ResourceReference} from '@itookit/app-contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {createVFSFileDiscoverySource, discoverFiles, FSError, type IVFSManager} from '@itookit/vfs-core';
import type {CommandBus, ISessionRepository} from '@itookit/llm-session';
interface Options {vfs: IVFSManager; projects?: ProjectService; repository: ISessionRepository}
interface ResourceSearchInput {query: string; scope: ResourceScope; includeIgnored?: boolean}
const log = createModuleLogger('resource-reference'), maxBytes = 2 * 1024 * 1024;
const navigations = new Set(['notes', 'emails', 'private', 'projects']);

export function registerResourceReferences(commands: CommandBus, options: Options) {
    const read = commands.register(ResourceCommand.Read, args => readResource(options, args as {reference: string; scope: ResourceScope}));
    const search = commands.register(ResourceCommand.Search, args => searchResources(options, args as ResourceSearchInput));
    return {dispose() {read.dispose(); search.dispose();}};
}
export async function readResource(options: Options, input: {reference: string; scope: ResourceScope}) {
    const operationId = randomUUID(), started = Date.now(); let stage = 'resolve';
    try {
        const reference = parseResourceReference(input.reference), source = await resolve(options, reference, input.scope);
        try {
            stage = 'read'; const node = await source.fs.driver.getNode(source.path);
            if (node?.type !== 'file') throw new FSError('ENOENT', 'Referenced file is unavailable');
            if ((node.size ?? 0) > maxBytes) throw new FSError('EFBIG', 'Referenced text exceeds 2 MiB');
            const raw = await source.fs.driver.readContent(source.path, {encoding: 'binary'}), bytes = new Uint8Array(raw);
            if (bytes.byteLength > maxBytes) throw new FSError('EFBIG', 'Referenced text exceeds 2 MiB');
            stage = 'decode'; const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
            if (text.includes('\0')) throw new FSError('EINVAL', 'Referenced file is not UTF-8 text');
            const result = {reference, scope: source.scope, path: source.path, text, bytes: bytes.byteLength, sha256: await sha256Hex(bytes)};
            log.info('resource.read', {operationId, stage: 'complete', result: 'success', bytes: bytes.byteLength, durationMs: Date.now() - started});
            return result;
        } finally {await source.release();}
    } catch (error) {
        log.warn('resource.read', {operationId, stage, result: 'failure', code: error instanceof FSError ? error.code : 'RESOURCE_READ_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
async function resolve(options: Options, ref: ResourceReference, supplied: ResourceScope) {
    const scope = {...supplied, navigation: ref.navigation ?? supplied?.navigation};
    if (!navigations.has(scope.navigation)) throw new FSError('EINVAL', 'Unknown resource navigation');
    if (scope.navigation !== 'projects') return {fs: await options.vfs.openFileSystem(`/home/admin/${scope.navigation}`), path: ref.path, scope, release: async () => {}};
    const projects = options.projects;
    if (!projects) throw new FSError('EINVAL', 'Project files are unavailable');
    if (!scope.projectId && scope.sessionId) scope.projectId = (await projects.forFolder((await options.repository.getManifest(scope.sessionId)).folder))?.project.id;
    if (ref.root === 'current') {
        if (!scope.projectId) throw new FSError('EINVAL', 'Select a project before using @/');
        const project = await projects.get(scope.projectId), owner = await projects.openFiles(project.path);
        return {fs: owner.fs, path: ref.path, scope, release: () => owner.dispose()};
    }
    const candidates = (await projects.list()).filter(project => [project.path, '/' + project.name, '/' + project.project.id]
        .some(prefix => ref.path.startsWith(prefix + '/')));
    if (candidates.length !== 1) throw new FSError(candidates.length ? 'EINVAL' : 'ENOENT', candidates.length ? 'Project name is ambiguous; select a unique project' : 'Project was not found');
    const project = candidates[0], prefix = [project.path, '/' + project.name, '/' + project.project.id].filter(prefix => ref.path.startsWith(prefix + '/')).sort((a,b) => b.length-a.length)[0];
    const owner = await projects.openFiles(project.path);
    return {fs: owner.fs, path: ref.path.slice(prefix.length), scope: {...scope, projectId: project.project.id}, release: () => owner.dispose()};
}
export async function searchResources(options: Options, input: ResourceSearchInput) {
    const operationId = randomUUID(), started = Date.now();
    try {
        const entries = await discoverResources(options, input);
        log.info('resource.search', {operationId, stage: 'complete', result: 'success', count: entries.length, durationMs: Date.now() - started});
        return entries;
    } catch (error) {
        log.warn('resource.search', {operationId, stage: 'discover', result: 'failure', code: error instanceof FSError ? error.code : 'RESOURCE_SEARCH_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
async function discoverResources(options: Options, input: ResourceSearchInput) {
    const raw = input.query.replace(/^@/, '');
    if (raw.startsWith('//') && input.scope.navigation === 'projects') return searchProjectResources(options, input, raw.slice(2));
    const named = /^([a-z][a-z0-9-]*):\/?(.*)$/.exec(raw);
    const scope = named ? {...input.scope, navigation: named[1]} : input.scope;
    const query = named ? named[2] : raw.replace(/^\/+/, '');
    const hints = [{label: 'notes:/', reference: '@notes:/'}, {label: '//', reference: '@//'}].filter(item => raw.length < item.label.length && item.label.startsWith(raw));
    if (!named && scope.navigation === 'projects' && !scope.projectId && !scope.sessionId) return hints;
    return [...hints, ...await searchFiles(options, scope, query, undefined, input.includeIgnored)];
}
async function searchProjectResources(options: Options, input: ResourceSearchInput, query: string) {
    if (!options.projects) throw new FSError('EINVAL', 'Project files are unavailable');
    const projects = await options.projects.list();
    const matches = projects.flatMap(project => [project.path.slice(1), project.name, project.project.id]
        .filter(prefix => query.startsWith(prefix + '/')).map(prefix => ({project, prefix})));
    const distinct = new Set(matches.map(match => match.project.project.id));
    if (distinct.size > 1) throw new FSError('EINVAL', 'Project name is ambiguous; select a unique project');
    const match = matches.sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!match) return projects.filter(project => [project.name, project.path].some(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
        .slice(0, 30).map(project => ({label: project.path, reference: formatResourceReference({root: 'navigation', path: project.path + '/'})}));
    return searchFiles(options, {...input.scope, navigation: 'projects', projectId: match.project.project.id}, query.slice(match.prefix.length + 1), '/' + match.prefix, input.includeIgnored);
}
async function searchFiles(options: Options, scope: ResourceScope, query: string, prefix?: string, includeIgnored?: boolean) {
    const source = await resolve(options, {root: 'current', path: '/'}, scope);
    try {
        const entries: Array<{label: string; reference: string}> = [];
        for await (const entry of discoverFiles(createVFSFileDiscoverySource(source.fs), '/', {includeIgnored})) {
            if (!entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
            entries.push({label: entry.path, reference: formatResourceReference({navigation: source.scope.navigation === 'projects' ? undefined : source.scope.navigation,
                root: prefix ? 'navigation' : 'current', path: (prefix ?? '') + entry.path})});
            if (entries.length >= 30) break;
        }
        return entries;
    } finally {await source.release();}
}
