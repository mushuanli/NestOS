import {createModuleLogger, randomUUID, sha256Hex} from '@itookit/common';
import {ResourceCommand, parseResourceReference, formatResourceReference, type ResourceScope, type ResourceReference} from '@itookit/app-contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {createVFSFileDiscoverySource, discoverFiles, FSError, type IVFSManager} from '@itookit/vfs-core';
import type {CommandBus, ISessionRepository} from '@itookit/llm-session';
interface Options {vfs: IVFSManager; projects?: ProjectService; repository: ISessionRepository}
const log = createModuleLogger('resource-reference'), maxBytes = 2 * 1024 * 1024;
const navigations = new Set(['notes', 'emails', 'private', 'projects']);

export function registerResourceReferences(commands: CommandBus, options: Options) {
    const read = commands.register(ResourceCommand.Read, args => readResource(options, args as {reference: string; scope: ResourceScope}));
    const search = commands.register(ResourceCommand.Search, args => searchResources(options, args as {query: string; scope: ResourceScope}));
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
async function searchResources(options: Options, input: {query: string; scope: ResourceScope}) {
    const named = /^@?([a-z][a-z0-9-]*):\/?(.*)$/.exec(input.query);
    const scope = named ? {...input.scope, navigation: named[1]} : input.scope;
    const query = named ? named[2] : input.query.replace(/^@?\//, '');
    const source = await resolve(options, {root: 'current', path: '/'}, scope);
    try {
        const entries: Array<{label: string; reference: string}> = [];
        for await (const entry of discoverFiles(createVFSFileDiscoverySource(source.fs), query)) {
            entries.push({label: entry.path, reference: formatResourceReference({navigation: source.scope.navigation === 'projects' ? undefined : source.scope.navigation, root: 'current', path: entry.path})});
            if (entries.length >= 30) break;
        }
        return entries;
    } finally {await source.release();}
}
