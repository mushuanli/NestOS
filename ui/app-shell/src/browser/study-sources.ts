import {createModuleLogger, randomUUID} from '@itookit/common';
import type {ApplicationServices} from '@itookit/app-contracts/services';
import type {StudyCreation} from '@itookit/mdxeditor';
import type {IFileSystem} from '@itookit/vfs-core';
const log = createModuleLogger('study-sources');
const readable = (path: string) => path.startsWith('/') && !path.split('/').some(part => part.startsWith('.') || part === '..')
    && /\.(md|mdx|markdown|mind|txt|csv|json|yaml|yml|rst)$/i.test(path);
interface Source {id: string; label: string; open(): Promise<{fs: IFileSystem; dispose(): Promise<void>}>}
/** Only caller-provided workspaces and current project capabilities are searched. */
export function studySources(services: ApplicationServices, workspaces: Array<{id: string; label: string; files(): Promise<IFileSystem>}>): NonNullable<StudyCreation['sources']> {
    const catalog = async (): Promise<Source[]> => [
        ...workspaces.map(workspace => ({id:'workspace:'+workspace.id,label:workspace.label,open:async()=>({fs:await workspace.files(),dispose:async()=>{}})})),
        ...(await services.projects.list()).map(project => ({id:'project:'+project.project.id,label:project.displayName || project.name,open:()=>services.projects.openFiles(project.path)})),
    ];
    return {search: async (query, signal, parent) => {
        const operationId = randomUUID(), started = Date.now(), keywords = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        log.info('study.sources.search', {operationId, stage:'locations', result:'start'});
        const sources = await catalog(); signal.throwIfAborted();
        if (!parent) {
            const items = sources.filter(source => !keywords.length || keywords.some(word => source.label.toLocaleLowerCase().includes(word)))
                .map(source => ({id: JSON.stringify([source.id, '/']), label: source.label, kind: 'directory' as const}));
            log.info('study.sources.search', {operationId, stage:'locations', result:'success', count:items.length, durationMs:Date.now()-started}); return items;
        }
        const [sourceId, path] = JSON.parse(parent), source = sources.find(source => source.id === sourceId);
        if (!source || typeof path !== 'string' || !visiblePath(path)) throw Object.assign(new Error('Invalid source location'), {code:'SOURCE_INVALID'});
        try {
            const items = await searchSource(source, path, keywords, signal);
            log.info('study.sources.search', {operationId, stage:'complete', result:'success', count:items.length, maxDirectories:20, resultLimit:50, maxDepth:keywords.length ? 2 : 0, durationMs:Date.now()-started}); return items;
        } catch (error) {
            log.warn('study.sources.search', {operationId, stage:'browse', result:'failure', code:signal.aborted ? 'SOURCE_SEARCH_CANCELLED' : 'SOURCE_SEARCH_FAILED', durationMs:Date.now()-started}); throw error;
        }
    }, read: async (id, signal) => {
        const operationId = randomUUID(), started = Date.now(); let stage = 'validate';
        try {
            const [sourceId, path] = JSON.parse(id), source = (await catalog()).find(source=>source.id===sourceId);
            if (!source || typeof path !== 'string' || !readable(path)) throw Object.assign(new Error('Invalid document source'),{code:'SOURCE_INVALID'});
            signal.throwIfAborted(); stage='open'; const owner=await source.open();
            try {
                const node=await owner.fs.driver.getNode(path); if (!node || node.type!=='file') throw Object.assign(new Error('Source missing'),{code:'SOURCE_MISSING'});
                if (node.size>8*1024*1024) throw Object.assign(new Error('Source too large'),{code:'SOURCE_TOO_LARGE'});
                stage='read'; const raw=await owner.fs.driver.readContent(path,{encoding:'utf-8',signal}); signal.throwIfAborted();
                log.info('study.sources.read',{operationId,stage:'complete',result:'success',durationMs:Date.now()-started}); return typeof raw==='string'?raw:new TextDecoder().decode(raw);
            } finally {await owner.dispose();}
        } catch (error) {log.warn('study.sources.read',{operationId,stage,result:'failure',code:(error as {code?:string}).code ?? 'SOURCE_READ_FAILED',durationMs:Date.now()-started});throw error;}
    }};
}
const visiblePath = (path: string) => path.startsWith('/') && !path.includes('\\') && !path.split('/').some(part => part.startsWith('.'));
async function searchSource(source: Source, path: string, keywords: string[], signal: AbortSignal): Promise<Array<{id:string;label:string;kind:'directory'|'document'}>> {
    signal.throwIfAborted(); const owner=await source.open();
    const matches:Array<{id:string;label:string;kind:'directory'|'document'}>=[], pending=[{path, depth:0}], visited=new Set<string>();
    try {
        while (pending.length && visited.size < 20) {
            signal.throwIfAborted(); const directory=pending.shift()!; if (visited.has(directory.path)) continue; visited.add(directory.path);
            const nodes = await owner.fs.driver.getChildren(directory.path, {fields:'entry',signal});
            for (const node of nodes) {
                if (!visiblePath(node.path) || (node.type !== 'directory' && !readable(node.path))) continue;
                const label=`${source.label} · ${node.path}`;
                if (keywords.every(word=>label.toLocaleLowerCase().includes(word))) matches.push({id:JSON.stringify([source.id,node.path]),label,kind:node.type==='directory'?'directory':'document'});
                if (matches.length===50) return matches;
                if (keywords.length && node.type==='directory' && directory.depth<2) pending.push({path:node.path,depth:directory.depth+1});
            }
        }
        return matches;
    } finally {await owner.dispose();}
}
