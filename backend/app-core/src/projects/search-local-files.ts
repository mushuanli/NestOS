import { checkOperation, createVFSFileDiscoverySource, discoverFiles, FSError, type IFileSystem, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectService } from '@itookit/app-contracts/services';
import type { ProjectSearchQuery, ProjectSearchMatch, ProjectSearchResult } from './project-search';

export async function searchLocalFiles(projects: ProjectService, folder: string, projectId: string, query: ProjectSearchQuery, options?: OperationOptions): Promise<ProjectSearchResult> {
    if (query.directory?.split('/').some(part => part.startsWith('.'))) return {matches: [], truncated: false, nextCursor: null};
    const owner = await projects.openFiles(folder), matches: ProjectSearchMatch[] = [];
    const source = createVFSFileDiscoverySource(owner.fs, options), list = source.list.bind(source);
    let count = 0, bytes = 0, truncated = false;
    source.list = async path => { if (++count > 2000) throw new FSError('EFBIG', 'Search directory capacity reached'); return (await list(path)).filter(entry => !entry.name.startsWith('.')); };
    try {
        for await (const node of discoverFiles(source, query.directory ? '/' + query.directory : '/', {signal: options?.signal, excludeDirectories: ['.git', '.codex', '.claude', '.ssh', '.aws', '.agents', 'node_modules']})) {
            checkOperation(options);
            if (++count > 2000 || bytes > 16 * 1024 * 1024 || matches.length >= 100) { truncated = true; break; }
            if (node.name.startsWith('.')) continue;
            const path = node.path.slice(1), base = {kind: 'file' as const, projectId, folder, path, title: path};
            if (query.scope === 'file-path' || query.scope === 'file-name') { if ((query.scope === 'file-name' ? node.name : path).toLowerCase().includes(query.query.toLowerCase())) matches.push({...base, summary: path}); continue; }
            if ((node.size ?? 0) > 2 * 1024 * 1024) { truncated = true; continue; }
            const text = await read(owner.fs, node.path, options); bytes += text.length * 2;
            if (text.includes('\0')) continue;
            matches.push(...textMatches(text, query.query, base).slice(0, 100 - matches.length));
        }
    } catch (error) { if ((error as {code?: string}).code !== 'EFBIG') throw error; truncated = true; }
    finally { await owner.dispose(); }
    return {matches, truncated: truncated || matches.length >= 100, nextCursor: null};
}
async function read(fs: IFileSystem, path: string, options?: OperationOptions): Promise<string> {
    const bytes = await fs.driver.readContent(path, {...options, encoding: 'binary', offset: 0, length: 2 * 1024 * 1024 + 1});
    if (bytes.byteLength > 2 * 1024 * 1024) throw new FSError('EFBIG', 'Search file capacity reached');
    return new TextDecoder().decode(bytes);
}
function textMatches(text: string, query: string, base: Omit<ProjectSearchMatch, 'summary'>): ProjectSearchMatch[] {
    if (query.includes('\n')) {
        const index = text.toLowerCase().indexOf(query.toLowerCase());
        return index < 0 ? [] : [{...base, line: text.slice(0, index).split('\n').length, summary: text.slice(index, index + 500)}];
    }
    const matches: ProjectSearchMatch[] = [];
    for (const [line, value] of text.split('\n').entries()) if (value.toLowerCase().includes(query.toLowerCase())) {
        matches.push({...base, line: line + 1, summary: value.slice(0, 500)}); if (matches.length >= 100) break;
    }
    return matches;
}
