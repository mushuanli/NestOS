import {FSError, type FSNode, type IFileSystem} from '@itookit/vfs-core';
import {browserTargetFolder, resolveBrowserTarget} from '@itookit/app-contracts';
import type {ProjectService, SessionDirectoryView, NavigationDirectory} from '@itookit/app-contracts/services';
import {createModuleLogger, randomUUID} from '@itookit/common';

const log = createModuleLogger('directory-view');
/** Flatten virtual containers locally; no browser round trip is needed for each group. */
export async function readDirectoryView(fs: IFileSystem, projects: ProjectService | undefined, path: string,
    options: {projectId?: string | null} = {}): Promise<SessionDirectoryView> {
    const operationId = randomUUID(), started = performance.now(), revision = fs.revision;
    const directories = new Map<string, NavigationDirectory & {path: string}>();
    try {
        const [nodes, navigation] = await Promise.all([flatten(fs, path, directories), projects?.navigation({path, projectId: options.projectId})]);
        const folder = browserTargetFolder(resolveBrowserTarget(path), path);
        const project = navigation?.projects.filter(item => folder === item.path || folder.startsWith(item.path + '/'))
            .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
        const stale = fs.revision !== revision;
        const result = {node: directories.get(path)!.node!, nodes, project, navigation,
            directories: directorySeeds(directories, nodes, fs.revision, stale)};
        log.debug('directory.read', {operationId, stage: 'aggregate', result: 'success', count: nodes.length, directoryCount: directories.size,
            durationMs: Math.round(performance.now() - started)});
        return result;
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        log.warn('directory.read', {operationId, stage: 'aggregate', result: 'failure',
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'DIRECTORY_READ_FAILED', durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}
function directorySeeds(directories: Map<string, NavigationDirectory & {path: string}>, entries: FSNode[], revision: number, stale: boolean): SessionDirectoryView['directories'] {
    const indices = new Map(entries.map((entry, index) => [entry, index]));
    return [...directories.values()].map(({nodes, ...directory}) => {
        const positions = nodes.map(node => indices.get(node));
        return positions.every(index => index !== undefined) ? {...directory, revision, stale, entryIndices: positions as number[]}
            : {...directory, revision, stale, nodes};
    });
}
async function flatten(fs: IFileSystem, path: string, directories: Map<string, NavigationDirectory & {path: string}>, ancestors = new Set<string>()): Promise<FSNode[]> {
    if (ancestors.has(path) || ancestors.size >= 16) throw new FSError('ELOOP', 'Cyclic directory projection');
    const [node, nodes] = await Promise.all([fs.driver.getNode(path), fs.driver.getChildren(path)]);
    if (!node) throw new FSError('ENOENT', 'Directory not found');
    if (node.type !== 'directory') throw new FSError('ENOTDIR', 'Not a directory');
    directories.set(path, {path, node, nodes, revision: fs.revision});
    const parents = new Set([...ancestors, path]);
    const rows = await Promise.all(nodes.filter(child => child.metadata.navigationHidden !== true).map(child => child.metadata.navigationTransparent === true
        ? flatten(fs, String(child.metadata.directoryPath ?? child.path), directories, parents) : [child]));
    return rows.flat();
}
