import { archivePath, decodeArchiveBytes } from './file-archive';
import { FSError } from '@itookit/vfs-core';
import type { ChatSessionSettings, ConversationManifest, ISessionRepository } from '@itookit/llm-session';

/** Durable Session bundle shared by the browser projection and the workbench export action. */
export const SESSION_BUNDLE_FORMAT = 'itookit.session';
export const SESSION_BUNDLE_VERSION = 2;

export interface SessionAttachmentBundle { name: string; base64: string }

/** Index and metadata carried across export/import. Storage identity and revisions are local. */
export interface SessionBundleManifest {
    title: string;
    summary?: string;
    origin?: ConversationManifest['origin'];
    folder?: string | null;
    uiState?: ConversationManifest['uiState'];
    flow?: ConversationManifest['flow'];
    rootRoundId: ConversationManifest['rootRoundId'];
    branches: ConversationManifest['branches'];
    branchMeta: ConversationManifest['branchMeta'];
    currentBranch: string;
    currentHead: ConversationManifest['currentHead'];
    children: ConversationManifest['children'];
}

export interface SessionBundle {
    format: typeof SESSION_BUNDLE_FORMAT;
    version: typeof SESSION_BUNDLE_VERSION;
    manifest: SessionBundleManifest;
    settings: ChatSessionSettings;
    documents: Record<string, string>;
    attachments: SessionAttachmentBundle[];
}

export interface SessionExport { name: string; content: string; mimeType: string }

/** Everything a Session owns: index, documents, settings and attachments. */
export async function exportSessionBundle(repository: ISessionRepository, sessionId: string): Promise<SessionExport> {
    const manifest = await repository.getManifest(sessionId);
    const documents: Record<string, string> = {};
    for (const name of await repository.listHistory(sessionId)) {
        const content = await repository.readDocument(sessionId, name);
        if (typeof content === 'string') documents[name] = content;
    }
    const bundle: SessionBundle = {
        format: SESSION_BUNDLE_FORMAT,
        version: SESSION_BUNDLE_VERSION,
        manifest: {
            title: manifest.title, summary: manifest.summary, origin: manifest.origin, folder: manifest.folder ?? null,
            uiState: manifest.uiState, flow: manifest.flow, rootRoundId: manifest.rootRoundId, branches: manifest.branches,
            branchMeta: manifest.branchMeta, currentBranch: manifest.currentBranch,
            currentHead: manifest.currentHead, children: manifest.children,
        },
        settings: await repository.getSessionSettings(sessionId),
        documents,
        attachments: await readAttachments(repository, sessionId),
    };
    return { name: `${manifest.title || sessionId}.session.json`, content: JSON.stringify(bundle, null, 2), mimeType: 'application/json' };
}

/**
 * Restore a bundle as a new Session. Validation happens before any write, and a
 * failure removes the partially imported Session instead of leaving it broken.
 */
export async function importSessionBundle(
    repository: ISessionRepository,
    content: string,
    options: { folder?: string | null } = {},
): Promise<string> {
    const bundle = parseSessionBundle(content);
    const folder = options.folder !== undefined ? options.folder : bundle.manifest.folder ?? null;
    const id = await repository.createSession(bundle.manifest.title || 'Imported Session', folder);
    try {
        await restoreSession(repository, id, bundle);
        return id;
    } catch (error) {
        try { await repository.deleteSession(id); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Session import and cleanup failed'); }
        throw error;
    }
}

async function restoreSession(repository: ISessionRepository, id: string, bundle: SessionBundle): Promise<void> {
    for (const [name, content] of Object.entries(bundle.documents)) await repository.writeDocument(id, name, content);
    // `folder` was applied by createSession from the import target; `title` and the
    // index fields come from the bundle.
    const { title, summary, origin, uiState, folder: _folder, ...index } = bundle.manifest;
    await repository.updateManifest(id, {
        title,
        ...(summary !== undefined ? { summary } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(uiState !== undefined ? { uiState } : {}),
        ...index,
    });
    await repository.saveSessionSettings(id, bundle.settings);
    for (const attachment of bundle.attachments) await repository.writeAttachment(id, attachment.name, bytesFromBase64(attachment.base64));
}

/** True when the text declares itself a Session bundle (v2 or legacy v1). */
export function isSessionBundle(content: string): boolean {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return false; }
    const record = asRecord(parsed);
    if (!record) return false;
    return (record.format === SESSION_BUNDLE_FORMAT && record.version === SESSION_BUNDLE_VERSION)
        || (record.history !== undefined && asRecord(record.manifest) !== null);
}

/** Accepts the current bundle and the legacy `{version:1, manifest, history}` shape. */
export function parseSessionBundle(content: string): SessionBundle {
    const record = asRecord(parseJson(content, 'Session bundle'));
    if (!record) throw new FSError('EINVAL', 'Session bundle must be a JSON object');
    const current = record.format === SESSION_BUNDLE_FORMAT && record.version === SESSION_BUNDLE_VERSION;
    const legacy = record.history !== undefined && asRecord(record.manifest) !== null;
    if (!current && !legacy) throw new FSError('EINVAL', `Unsupported Session bundle: format=${String(record.format)} version=${String(record.version)}`);
    const documents = readDocuments(current ? record.documents : record.history);
    return {
        format: SESSION_BUNDLE_FORMAT,
        version: SESSION_BUNDLE_VERSION,
        manifest: readManifest(record.manifest, documents),
        settings: (asRecord(record.settings) ?? {}) as unknown as ChatSessionSettings,
        documents,
        attachments: readAttachmentsRecord(record.attachments),
    };
}

function readManifest(value: unknown, documents: Record<string, string>): SessionBundleManifest {
    const manifest = asRecord(value);
    if (!manifest) throw new FSError('EINVAL', 'Session bundle has no manifest');
    const branches = readHeads(manifest.branches);
    const currentHead = readHead(manifest.currentHead);
    const rootRoundId = readHead(manifest.rootRoundId);
    const currentBranch = typeof manifest.currentBranch === 'string' && manifest.currentBranch
        ? manifest.currentBranch : Object.keys(branches)[0] ?? 'main';
    for (const [ref, head] of Object.entries(branches)) requireRound(documents, head, `branch ${ref}`);
    requireRound(documents, currentHead, 'currentHead');
    requireRound(documents, rootRoundId, 'rootRoundId');
    if (!(currentBranch in branches)) branches[currentBranch] = currentHead;
    else if (currentHead && branches[currentBranch] !== currentHead) branches[currentBranch] = currentHead;
    return {
        title: typeof manifest.title === 'string' ? manifest.title : '',
        summary: typeof manifest.summary === 'string' ? manifest.summary : undefined,
        origin: manifest.origin === 'cli' || manifest.origin === 'tauri' || manifest.origin === 'web' ? manifest.origin : undefined,
        folder: typeof manifest.folder === 'string' ? manifest.folder : null,
        uiState: (asRecord(manifest.uiState) ?? undefined) as ConversationManifest['uiState'],
        flow: (asRecord(manifest.flow) ?? undefined) as ConversationManifest['flow'],
        rootRoundId, branches,
        branchMeta: (asRecord(manifest.branchMeta) ?? {}) as ConversationManifest['branchMeta'],
        currentBranch, currentHead,
        children: readChildren(manifest.children, documents),
    };
}

function readDocuments(value: unknown): Record<string, string> {
    const record = asRecord(value);
    if (!record) throw new FSError('EINVAL', 'Session bundle has no documents');
    const documents: Record<string, string> = {};
    for (const [name, content] of Object.entries(record)) {
        if (typeof content !== 'string') throw new FSError('EINVAL', `Session document is not text: ${name}`);
        archivePath(name); if (name.includes('/') || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new FSError('EINVAL', 'Invalid Session document name');
        assertRoundIdentity(name, parseJson(content, name));
        documents[name] = content;
    }
    return documents;
}

/** A round document is identified by its filename: round-<roundId>.json. */
function assertRoundIdentity(name: string, parsed: unknown): void {
    if (!/^round-.+\.json$/.test(name)) return;
    const roundId = name.slice('round-'.length, -'.json'.length);
    if (asRecord(parsed)?.id !== roundId) throw new FSError('EINVAL', `Session round document identity mismatch: ${name}`);
}

function readChildren(value: unknown, documents: Record<string, string>): ConversationManifest['children'] {
    const record = asRecord(value) ?? {};
    const children: ConversationManifest['children'] = {};
    for (const [roundId, ids] of Object.entries(record)) {
        if (!hasRound(documents, roundId) || !Array.isArray(ids)) continue;
        const kept = ids.filter((id): id is string => typeof id === 'string' && hasRound(documents, id));
        if (kept.length) children[roundId] = kept;
    }
    return children;
}

function readHeads(value: unknown): ConversationManifest['branches'] {
    const record = asRecord(value);
    if (!record) return { main: null };
    const branches: ConversationManifest['branches'] = {};
    for (const [ref, head] of Object.entries(record)) branches[ref] = readHead(head);
    return Object.keys(branches).length ? branches : { main: null };
}

function readHead(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !value) throw new FSError('EINVAL', 'Invalid Session round reference');
    return value;
}

function requireRound(documents: Record<string, string>, roundId: string | null, label: string): void {
    if (roundId && !hasRound(documents, roundId)) throw new FSError('EINVAL', `Session ${label} points at a missing round: ${roundId}`);
}

function hasRound(documents: Record<string, string>, roundId: string): boolean {
    return documents[`round-${roundId}.json`] !== undefined;
}

function readAttachmentsRecord(value: unknown): SessionAttachmentBundle[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new FSError('EINVAL', 'Session attachments must be a list');
    return value.map(entry => {
        const record = asRecord(entry);
        if (!record || typeof record.name !== 'string' || !record.name || record.name.includes('/') || typeof record.base64 !== 'string') {
            throw new FSError('EINVAL', 'Invalid Session attachment entry');
        }
        archivePath(record.name); decodeArchiveBytes(record.base64);
        return { name: record.name, base64: record.base64 };
    });
}

async function readAttachments(repository: ISessionRepository, sessionId: string): Promise<SessionAttachmentBundle[]> {
    const view = await repository.openAttachments(sessionId);
    try {
        const files: SessionAttachmentBundle[] = [];
        for (const node of await view.driver.getChildren('/')) {
            if (node.type !== 'file') continue;
            const content = await view.driver.readContent(node.path, { encoding: 'binary' });
            files.push({ name: node.name, base64: base64FromBytes(new Uint8Array(content)) });
        }
        return files;
    } finally {
        await view.dispose();
    }
}

function parseJson(content: string, label: string): unknown {
    try { return JSON.parse(content); } catch { throw new FSError('EINVAL', `${label} is not valid JSON`); }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function base64FromBytes(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function bytesFromBase64(value: string): ArrayBuffer {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer as ArrayBuffer;
}
