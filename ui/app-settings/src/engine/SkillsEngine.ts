/**
 * @file app-settings/engine/SkillsEngine.ts
 * @desc Custom IFileSystem implementation — maps LLMSkill objects to virtual file nodes.
 *       Read-write via IAgentManagementService. Flat list, no directories.
 *
 * v3.3: Refactored from IFSEngine → IFileSystem.
 *
 * Event payloads match EngineAdapter expectations:
 *   node:created → { nodes: [{nodeId, parentId, path, type}] }
 *   node:updated → { nodes: [{nodeId}] }
 *   node:deleted → { requestedIds, allDeletedIds }
 *   node:renamed → { nodes: [{nodeId, oldName, newName}] }
 *   node:moved   → empty nodes list (triggers EngineAdapter.loadData() full refresh)
 */
import type {
    IFileSystem,
    IFSDriver,
    FSCapabilities,
    FSNode,
    FSFileNode,
    FSSearchResult,
    FileSystemStats,
    FileContent,
    ReadOptions,
    ListOptions,
    FSSearchQuery,
    CreateFileOptions,
    CreateDirectoryOptions,
    DeleteOptions,
    RenameOptions,
    MoveOptions,
    FSEventType,
    FSEvent,
    FSEventPayloadMap,
    IAssetOperations,
    ITagOperations,
} from '@itookit/vfs-core';
import type { LLMSkill, IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { FSCapabilityError } from '@itookit/vfs-core';
import { EventBus } from '@itookit/vfs-core';
import yaml from 'js-yaml';

/** Strip common skill file extensions from a user-typed or imported filename. */
function cleanName(raw: string): string {
    return raw.replace(/\.(skill\.(yaml|yml)|yaml|yml|json)$/i, '').trim() || raw.trim();
}

function toSkillId(path: string): string {
    return path.startsWith('/') ? path.slice(1) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSkillType(value: unknown): value is LLMSkill['type'] {
    return ['builtin', 'http', 'shell', 'prompt', 'mcp', 'custom'].includes(String(value));
}

function isSkillDefinition(value: unknown): value is LLMSkill {
    if (!isRecord(value)) return false;
    return typeof value.id === 'string'
        && typeof value.name === 'string'
        && typeof value.description === 'string'
        && isSkillType(value.type)
        && typeof value.enabled === 'boolean'
        && typeof value.instructions === 'string'
        && Array.isArray(value.tools)
        && Array.isArray(value.triggerPatterns)
        && typeof value.autoLoad === 'boolean'
        && typeof value.priority === 'number';
}

// ── 能力声明 ───────────────────────────────────────────────────

const SKILLS_CAPS: FSCapabilities = Object.freeze({
    readonly: false, search: true, semanticSearch: false, syncable: false,
    assets: false, tags: true, deviceFiles: false,
    seqFiles: false, references: false, symlinks: false, hardlinks: false,
    partialRead: false, partialWrite: false, treeWalk: false,
    streaming: false, watch: false, mount: false,
});

// ── Assets no-op ───────────────────────────────────────────────

const noopAssets: IAssetOperations = {
    putAsset: async () => ({ type: 'file' } as FSFileNode),
    getAsset: async () => null,
    getAssetDirPath: async () => null,
    ensureAssetDir: async () => { throw new FSCapabilityError('assets', 'skills'); },
    listAssets: async () => [],
    deleteAsset: async () => {},
    removeAssetDir: async () => {},
    hasAssetDir: async () => false,
};

// ═══════════════════════════════════════════════════════════════
// SkillsEngine
// ═══════════════════════════════════════════════════════════════

export class SkillsEngine implements IFileSystem {
    readonly revision = 0;
    async capabilitiesAt(_path: string) { return this.capabilities; }
    readonly viewId = 'skills';
    readonly capabilities: FSCapabilities = SKILLS_CAPS;
    readonly driver: IFSDriver;
    readonly meta: import('@itookit/vfs-core').IFSMetaDriver;
    readonly tags: ITagOperations;

    private unsubscribe: (() => void) | null = null;

    constructor(service: IAgentManagementService) {
        const driverImpl = new SkillsDriver(service);
        this.driver = driverImpl;

        // Tags impl delegates to driver's setTags
        const engine = this;
        this.tags = {
            getAllTags: async () => [],
            setTags: (id: string, tags: string[]) => engine.driver.updateMetadata(id, { tags }),
            addTag: async () => {},
            removeTag: async () => {},
            walkByTag: async () => ({ total: 0, processed: 0 }),
        };

        this.meta = {
            assets: noopAssets,
            tags: this.tags,
        };

        this.unsubscribe = service.onChange(() => {
            if (!driverImpl.isSuppressingEvents) {
                driverImpl.fire('node:moved', { nodes: [] });
            }
        });
    }

    async init(): Promise<void> {}

    openFile(_nodeId: string): never {
        throw new Error('SkillsEngine: openFile not supported');
    }

    async dispose(): Promise<void> {
        this.unsubscribe?.();
    }

    on<E extends FSEventType>(event: E, callback: (event: FSEvent<E>) => void): () => void {
        return this.driver.on(event, callback);
    }
}

// ═══════════════════════════════════════════════════════════════
// SkillsDriver — 内联 IFSDriver
// ═══════════════════════════════════════════════════════════════

class SkillsDriver implements IFSDriver {
    readonly viewId = 'skills';
    readonly capabilities: FSCapabilities = SKILLS_CAPS;
    private readonly events = new EventBus<FSEventPayloadMap>();
    private suppressEvents = false;

    constructor(private readonly service: IAgentManagementService) {}

    // ── Events ───────────────────────────────────────
    on<E extends FSEventType>(event: E, callback: (event: FSEvent<E>) => void): () => void {
        return this.events.on(event, (payload, meta) => {
            callback({
                type: event,
                payload,
                timestamp: meta.timestamp,
                viewId: this.viewId,
            });
        });
    }

    /** @internal — used by SkillsEngine to fire events */
    fire<E extends FSEventType>(type: E, payload: FSEventPayloadMap[E]): void {
        this.events.emit(type, payload);
    }

    get isSuppressingEvents(): boolean {
        return this.suppressEvents;
    }

    // ── Read ─────────────────────────────────────────

    async getNode(id: string): Promise<FSNode | null> {
        if (id === "/") return { type: "directory", path: "/", name: "skills", parentPath: null, createdAt: 0, modifiedAt: 0, version: 0, tags: [], metadata: {} };
        const skills = await this.service.getSkills();
        const skillId = toSkillId(id);
        const s = skills.find((x: LLMSkill) => x.id === skillId);
        return s ? toFSNode(s) : null;
    }

    async getChildren(parentId: string, _options?: ListOptions): Promise<FSNode[]> {
        if (parentId !== '/') return [];
        const skills = await this.service.getSkills();
        return skills.map((s: LLMSkill) => toFSNode(s));
    }

    readContent(id: string, options: ReadOptions & { encoding: 'utf-8' }): Promise<string>;
    readContent(id: string, options: ReadOptions & { encoding: 'binary' }): Promise<ArrayBuffer>;
    readContent(id: string, options?: ReadOptions): Promise<FileContent>;
    async readContent(id: string, _options?: ReadOptions): Promise<FileContent> {
        return toSkillId(id);
    }

    async resolvePath(_path: string): Promise<string | null> {
        if (_path === "/") return "/";
        const skills = await this.service.getSkills();
        for (const s of skills) {
            if (_path === `/${s.id}` || _path === s.id) return `/${s.id}`;
        }
        return null;
    }

    async exists(id: string): Promise<boolean> {
        if (id === "/") return true;
        const skills = await this.service.getSkills();
        const skillId = toSkillId(id);
        return skills.some((s: LLMSkill) => s.id === skillId);
    }

    async search(query: FSSearchQuery): Promise<FSSearchResult> {
        const text = query.name?.contains;
        const nodes: FSNode[] = [];
        if (text) {
            const lower = text.toLowerCase();
            const skills = await this.service.getSkills();
            for (const s of skills as LLMSkill[]) {
                if (s.name.toLowerCase().includes(lower) ||
                    s.id.includes(lower) ||
                    (s.description ?? '').toLowerCase().includes(lower)) {
                    nodes.push(toFSNode(s));
                }
            }
        }
        return { nodes: nodes, total: nodes.length, hasMore: false };
    }

    async getStats(): Promise<FileSystemStats> {
        const skills = await this.service.getSkills();
        return { fileCount: skills.length, directoryCount: 1, totalSize: 0, lastModifiedAt: Date.now() };
    }

    // ── Write ────────────────────────────────────────

    async writeContent(id: string, content: FileContent): Promise<void> {
        id = toSkillId(id);
        const text = typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer);
        if (!text.trim()) { console.warn('[skill] writeContent: empty, skipping'); return; }

        let incoming: unknown;
        try { incoming = yaml.load(text); } catch (e) { console.error('[skill] writeContent: yaml failed', e); return; }
        if (!isRecord(incoming)) return;

        const skills = await this.service.getSkills() as LLMSkill[];
        const existing = skills.find((s: LLMSkill) => s.id === id);
        const targetId = (typeof incoming.id === 'string' && incoming.id.trim()) ? incoming.id.trim() : id;

        const candidate: unknown = {
            ...existing,
            ...incoming,
            id: targetId,
            modifiedAt: Date.now(),
        };
        if (!isSkillDefinition(candidate)) {
            console.error('[skill] writeContent: invalid skill definition');
            return;
        }
        const updated = candidate;
        await this.service.saveSkill(updated);

        if (targetId !== id) {
            if (existing) await this.service.deleteSkill(id).catch(() => {});
            this.fire('node:deleted', {
                requestedPaths: [`/${id}`],
                allDeletedPaths: [`/${id}`],
            });
            this.fire('node:created', {
                nodes: [{ parentPath: null, path: `/${targetId}`, type: 'file' }],
            });
        } else {
            this.fire('node:updated', {
                nodes: [{ path: `/${targetId}`, changedFields: ['content'] }],
                reason: 'content',
            });
        }
    }

    async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
        id = toSkillId(id);
        const skills = await this.service.getSkills() as LLMSkill[];
        const s = skills.find((x: LLMSkill) => x.id === id);
        if (!s) return;

        const updates: Partial<LLMSkill> = {};
        if ('icon' in metadata) updates.icon = (metadata.icon as string) || undefined;
        if ('description' in metadata) updates.description = (metadata.description as string) || undefined;

        if (Object.keys(updates).length === 0) return;

        this.suppressEvents = true;
        try {
            await this.service.saveSkill({ ...s, ...updates, modifiedAt: Date.now() });
        } finally {
            this.suppressEvents = false;
        }
        this.fire('node:updated', {
            nodes: [{ path: `/${id}`, changedFields: ['metadata'] }],
            reason: 'metadata',
        });
    }

    async appendContent(): Promise<void> { throw new Error('not supported'); }

    async createFile(options: CreateFileOptions): Promise<FSNode> {
        const rawName = options.name;
        const content = options.content;

        if (content) {
            const text = typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer);
            try {
                const parsed = yaml.load(text);
                if (isRecord(parsed)) {
                    const skillId = (typeof parsed.id === 'string' && parsed.id.trim())
                        ? parsed.id.trim()
                        : cleanName(rawName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `skill-${Date.now()}`;
                    const skillName = (typeof parsed.name === 'string' && parsed.name.trim())
                        ? parsed.name.trim()
                        : cleanName(rawName);

                    const candidate: unknown = {
                        description: '', instructions: '', tools: [],
                        triggerPatterns: [], autoLoad: false, priority: 50,
                        type: 'prompt', enabled: false,
                        ...parsed, id: skillId, name: skillName,
                        createdAt: typeof parsed.createdAt === 'number'
                            ? parsed.createdAt
                            : Date.now(),
                        modifiedAt: Date.now(),
                    };
                    if (!isSkillDefinition(candidate)) {
                        throw new Error('Invalid skill definition');
                    }
                    const skill = candidate;
                    await this.service.saveSkill(skill);
                    const node = toFSNode(skill);
                    this.fire('node:created', {
                        nodes: [{ parentPath: null, path: `/${skill.id}`, type: 'file' }],
                    });
                    return node;
                }
            } catch (e) {
                console.warn('[skill] createFile: YAML parse failed, fallback to filename', e);
            }
        }

        // Fallback: no content or invalid YAML
        const name = cleanName(rawName);
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `skill-${Date.now()}`;
        const now = Date.now();
        const skill: LLMSkill = {
            id, name, type: 'prompt', enabled: false,
            description: '', instructions: '', tools: [],
            triggerPatterns: [], autoLoad: false, priority: 50,
            createdAt: now, modifiedAt: now,
        };
        await this.service.saveSkill(skill);
        const node = toFSNode(skill);
        this.fire('node:created', {
            nodes: [{ parentPath: null, path: `/${id}`, type: 'file' }],
        });
        return node;
    }

    async createDirectory(_options: CreateDirectoryOptions): Promise<FSNode> {
        throw new Error('not supported');
    }

    async rename(id: string, newName: string, _opts?: RenameOptions): Promise<void> {
        id = toSkillId(id);
        const skills = await this.service.getSkills() as LLMSkill[];
        const s = skills.find((x: LLMSkill) => x.id === id);
        if (!s || s.name === newName) return;
        const oldName = s.name;
        this.suppressEvents = true;
        try {
            await this.service.saveSkill({ ...s, name: newName, modifiedAt: Date.now() });
        } finally {
            this.suppressEvents = false;
        }
        this.fire('node:renamed', {
            nodes: [{
                oldPath: `/${id}`,
                newPath: `/${id}`,
                oldName,
                newName,
            }],
        });
    }

    async delete(ids: string[], _options?: DeleteOptions): Promise<void> {
        ids = ids.map(toSkillId);
        for (const id of ids) {
            await this.service.deleteSkill(id);
        }
        const paths = ids.map(id => `/${id}`);
        this.fire('node:deleted', {
            requestedPaths: paths,
            allDeletedPaths: paths,
        });
    }

    async move(_ids: string[], _parent: string | null, _opts?: MoveOptions): Promise<void> {
        // Flat list — no-op
    }

    // ── Links (unsupported) ───────────────────────────
    async symlink(): Promise<FSNode> { throw new FSCapabilityError('symlinks', this.viewId); }
    async readlink(): Promise<string> { throw new FSCapabilityError('symlinks', this.viewId); }
    async hardlink(): Promise<FSNode> { throw new FSCapabilityError('hardlinks', this.viewId); }

    // ── Transaction (unsupported) ────────────────────
    async transaction<T>(): Promise<T> {
        throw new FSCapabilityError('transaction', this.viewId);
    }
}

// ═══════════════════════════════════════════════════════════════
// Helper
// ═══════════════════════════════════════════════════════════════

function toFSNode(s: LLMSkill): FSFileNode {
    return {
        parentPath: null,
        name: s.id,
        type: 'file',
        icon: s.icon ?? '⚡',
        path: `/${s.id}`,
        size: 0,
        createdAt: s.createdAt ?? Date.now(),
        modifiedAt: s.modifiedAt ?? Date.now(),
        version: 0,
        viewId: 'skills',
        tags: s.enabled ? [] : ['disabled'],
        metadata: {
            title: s.name,
            lastModified: s.modifiedAt ?? Date.now(),
            hasUnreadUpdate: s.enabled,
            skillType: s.type,
            enabled: s.enabled,
        },
    };
}
