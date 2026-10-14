import { discoverWorkspaces } from './workspace-catalog';
import { sha256HexSync } from '@itookit/llm-context';
import { FSError, type IFileSystem } from '@itookit/vfs-core';
import { RoundLog, type SessionRepository } from '@itookit/llm-session';
import type { ProjectService } from '@itookit/app-contracts/services';
import { TwinProjectCatalog, documentPath, nodeVersion } from './project-catalog';
import { readHarness } from './harness-reader';
import type { TwinSourceContent, TwinSourceReader, TwinSourceSpec } from './domain';

const MAX_BYTES = 1024 * 1024;
/** Read ordinary project documents and visible conversations through existing application services. */
export class MindosTwinSourceReader implements TwinSourceReader {
    constructor(private readonly fs: IFileSystem, private readonly sessionsRepository: SessionRepository, private readonly projects?: ProjectService) {}
    async discover() {
        if (!this.projects) throw new Error('TWIN_PROJECT_CATALOG_UNAVAILABLE');
        const catalog = await new TwinProjectCatalog(this.projects, this.sessionsRepository).discover();
        await discoverWorkspaces(this.fs, catalog); return catalog;
    }
    async sessions() { return (await this.sessionsRepository.list()).filter(session => !session.id.startsWith('twin-analysis-'))
        .map(session => ({ id: session.id, title: session.title })); }

    async read(spec: TwinSourceSpec): Promise<TwinSourceContent> {
        if (!spec || !['file', 'session', 'harness-session'].includes(spec.kind) || typeof spec.target !== 'string' || !spec.target.trim()
            || spec.target.length > 1000 || typeof spec.label !== 'string' || spec.label.length > 200) throw new Error('TWIN_INVALID_SOURCE');
        if (spec.kind === 'harness-session') {
            if (!this.projects) throw new Error('TWIN_PROJECT_CATALOG_UNAVAILABLE');
            return readHarness(this.projects, spec.target);
        }
        if (spec.kind === 'file' && spec.target.startsWith('project://')) return this.projectFile(spec.target);
        return spec.kind === 'file' ? this.file(spec.target) : this.session(spec.target);
    }

    async probe(spec: TwinSourceSpec): Promise<string> {
        if (spec.kind !== 'file') return '';
        if (spec.target.startsWith('project://')) return this.projectFile(spec.target, true).then(value => value.hash);
        validatePath(spec.target);
        const node = await this.fs.driver.getNode(spec.target);
        if (!node) throw new FSError('ENOENT', 'Twin source missing');
        return ''; // Legacy paths retain full checks, including protected ancestors.
    }
    private async projectFile(target: string, probe = false): Promise<TwinSourceContent> {
        if (!this.projects) throw new Error('TWIN_PROJECT_CATALOG_UNAVAILABLE');
        const url = new URL(target), id = decodeURIComponent(url.hostname), path = decodeURIComponent(url.pathname);
        if (!documentPath(path) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('TWIN_SOURCE_SCOPE');
        const project = (await this.projects.list()).find(item => item.project.id === id);
        if (!project) throw new FSError('ENOENT', 'Twin project missing');
        const source = await this.projects.openFiles(project.path);
        try {
            const node = await ordinaryNode(source.fs, path);
            const binding = JSON.stringify([id, project.project.directory, project.project.source, this.projects.remoteMounts?.list(id).map(mount =>
                [mount.at, mount.root, mount.connectionId, mount.serverId, mount.serverProjectId])]);
            if (probe) return { text: '', hash: binding + nodeVersion(node), nativeIdentity: '' };
            const text = await source.fs.driver.readContent(path, { encoding: 'utf-8' });
            const after = await ordinaryNode(source.fs, path);
            if (nodeVersion(node) !== nodeVersion(after)) throw new Error('TWIN_SOURCE_CHANGED');
            if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('TWIN_SOURCE_LIMIT');
            return { text, hash: sha256HexSync(text), nativeIdentity: JSON.stringify([binding, path, node.createdAt]) };
        } finally { await source.dispose(); }
    }
    private async file(path: string): Promise<TwinSourceContent> {
        validatePath(path);
        const parts = path.split('/').filter(Boolean);
        for (let length = 3; length < parts.length; length++) {
            const parent = await this.fs.driver.getNode('/' + parts.slice(0, length).join('/'));
            if (parent?.metadata.isProtected || parent?.tags.includes('private')) throw new Error('TWIN_PRIVATE_SOURCE');
        }
        const before = await this.fs.driver.getNode(path);
        if (!before) throw new FSError('ENOENT', 'Twin source missing');
        if (before.type !== 'file' || before.metadata.isProtected || before.tags.includes('private')) throw new Error('TWIN_PRIVATE_SOURCE');
        if (before.size > MAX_BYTES) throw new Error('TWIN_SOURCE_LIMIT');
        const text = await this.fs.driver.readContent(path, { encoding: 'utf-8' });
        const after = await this.fs.driver.getNode(path);
        if (!after || after.createdAt !== before.createdAt || after.version !== before.version) throw new Error('TWIN_SOURCE_CHANGED');
        if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('TWIN_SOURCE_LIMIT');
        return { text, hash: sha256HexSync(text), nativeIdentity: JSON.stringify([path, before.createdAt]) };
    }

    private async session(id: string): Promise<TwinSourceContent> {
        if (id.startsWith('twin-analysis-')) throw new Error('TWIN_RECURSIVE_SOURCE');
        const manifest = await this.sessionsRepository.getManifest(id);
        const log = new RoundLog(this.sessionsRepository, id);
        const head = manifest.currentHead;
        const texts = await sessionTexts(log, head);
        if (head !== (await this.sessionsRepository.getManifest(id)).currentHead) throw new Error('TWIN_SOURCE_CHANGED');
        const text = texts.join('\n');
        return { text, hash: sha256HexSync(text), nativeIdentity: JSON.stringify([id, manifest.createdAt]) };
    }
}

function validatePath(path: string): void {
    const parts = path.split('/');
    if (!path.startsWith('/home/admin/') || parts.some(part => part === '.' || part === '..' || part.startsWith('.'))
        || /\/(?:private|agents|skills|flows|chats|sessions|toolbox)(?:\/|$)/i.test(path)
        || !documentPath(path)) throw new Error('TWIN_SOURCE_SCOPE');
}

function publicMessages(messages: Array<{ role: string; content: unknown }>) {
    return messages.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
        .map(message => ({ role: message.role, content: message.content }));
}

async function sessionTexts(log: RoundLog, head: string | null): Promise<string[]> {
    const texts: string[] = []; let cursor = head, bytes = 0;
    const visited = new Set<string>();
    while (cursor) {
        if (visited.has(cursor) || visited.size >= 2000) throw new Error('TWIN_SOURCE_LIMIT');
        visited.add(cursor);
        const round = await log.readRound(cursor);
        if (!round || round._deleted) throw new Error('TWIN_HISTORY_INCOMPLETE');
        if (['pending', 'running', 'waiting'].includes(round.status)) throw new Error('TWIN_SOURCE_BUSY');
        if (round.exposure && round.exposure !== 'public') throw new Error('TWIN_HISTORY_SCOPE');
        if (round.historyParentIds.length > 1) throw new Error('TWIN_HISTORY_MERGE_UNSUPPORTED');
        const text = JSON.stringify({ id: round.id, time: round.createdAt,
        input: publicMessages(round.input), output: publicMessages(round.output) });
        bytes += new TextEncoder().encode(text).length;
        if (bytes > MAX_BYTES) throw new Error('TWIN_SOURCE_LIMIT');
        texts.unshift(text); cursor = round.historyParentIds[0] ?? null;
    }
    return texts;
}

async function ordinaryNode(fs: IFileSystem, path: string) {
    const parts = path.split('/').filter(Boolean);
    for (let size = 0; size < parts.length; size++) {
        const parent = await fs.driver.getNode('/' + parts.slice(0, size).join('/'));
        if (parent?.metadata.isProtected || parent?.tags.includes('private')) throw new Error('TWIN_PRIVATE_SOURCE');
    }
    const node = await fs.driver.getNode(path);
    if (!node) throw new FSError('ENOENT', 'Twin source missing');
    if (node.type !== 'file' || node.metadata.isProtected || node.tags.includes('private')) throw new Error('TWIN_PRIVATE_SOURCE');
    if (node.size > MAX_BYTES) throw new Error('TWIN_SOURCE_LIMIT');
    return node;
}
