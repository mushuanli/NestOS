import type { DagPluginCatalog, FlowConnection, FlowDraft, FlowRevision } from './contracts';
import { flowRevisionDigest, hasValidationErrors, validateFlowRevision } from './flow/validation';

/**
 * Minimal storage face for workflow files. A workflow lives in a single `.flow`
 * file (the mutable draft); immutable revisions are stored as assets under that
 * file. Implemented by the session layer's FlowEngine (flows VFS module).
 */
export interface FlowFileRef {
    nodeId: string;
    name: string;
}

export interface FlowStore {
    listFiles(): Promise<FlowFileRef[]>;
    /** Resolve a single file by name (O(1)); null when absent. */
    findFile(name: string): Promise<FlowFileRef | null>;
    createFile(name: string, content: string): Promise<FlowFileRef>;
    readFile(nodeId: string): Promise<string | null>;
    writeFile(nodeId: string, content: string): Promise<void>;
    renameFile(nodeId: string, newName: string): Promise<void>;
    deleteFile(nodeId: string): Promise<void>;
    createAsset(ownerNodeId: string, filename: string, content: string | ArrayBuffer): Promise<unknown>;
    readAsset(ownerNodeId: string, filename: string): Promise<string | ArrayBuffer | null>;
    listAssets(ownerNodeId: string): Promise<Array<{ path?: string; name?: string }>>;
}

export class FlowDraftVersionConflictError extends Error {
    constructor(
        readonly flowId: string,
        readonly expectedVersion: number,
        readonly actualVersion: number,
    ) {
        super(`Flow draft ${flowId} version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
        this.name = 'FlowDraftVersionConflictError';
    }
}

const FLOW_EXTENSION = '.flow';

/** Workflow draft/revision persistence: one .flow file per flow + revision assets. */
export class FlowDefinitionStore {
    /** Installation receipts survive file deletion, so startup respects user removal. */
    async installBuiltinDraft(template: FlowDraft, options: { restoreMissing?: boolean } = {}): Promise<FlowDraft | null> {
        const name = fileName(String(template.id));
        const receipt = `.installed-${name}.json`;
        const installed = await this.store.findFile(receipt);
        if (installed && !options.restoreMissing) return null;
        const existing = await this.store.findFile(name);
        const draft = { ...structuredClone(template), draftVersion: 1, updatedAt: Date.now() };
        if (!existing) await this.store.createFile(name, JSON.stringify(draft, null, 2));
        if (!installed) await this.store.createFile(receipt, JSON.stringify({ flowId: template.id, installedAt: Date.now() }));
        return existing ? null : draft;
    }
    constructor(
        private readonly store: FlowStore,
        private readonly plugins?: DagPluginCatalog,
    ) {}

    /** v3 draft plane: drafts are mutable and are never used as run input. */
    async createDraft(input: { id: string; name: string }): Promise<FlowDraft> {
        assertFlowId(input.id);
        if (!input.name.trim()) throw new Error('Flow name is required');
        if (await this.resolveNodeId(input.id)) {
            throw new Error(`Flow draft already exists: ${input.id}`);
        }
        const draft: FlowDraft = {
            id: input.id as FlowDraft['id'],
            draftVersion: 1,
            name: input.name.trim(),
            nodes: [],
            edges: [],
            layout: {},
            parameters: [],
            connections: [],
            updatedAt: Date.now(),
        };
        await this.store.createFile(fileName(input.id), JSON.stringify(draft, null, 2));
        return draft;
    }

    async listDrafts(): Promise<FlowDraft[]> {
        const files = (await this.store.listFiles())
            .filter(file => file.name.toLowerCase().endsWith(FLOW_EXTENSION));
        const drafts = await Promise.all(files.map(async file => {
            const content = await this.store.readFile(file.nodeId);
            return content ? parseFlowDraft(content) : null;
        }));
        return drafts.filter((draft): draft is FlowDraft => Boolean(draft))
            .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    async saveDraft(draft: FlowDraft, expectedDraftVersion: number): Promise<FlowDraft> {
        const nodeId = await this.resolveNodeId(String(draft.id));
        if (!nodeId) throw new Error(`Flow draft not found: ${draft.id}`);
        const current = parseFlowDraft(await this.store.readFile(nodeId));
        const actualVersion = current?.draftVersion ?? 0;
        if (actualVersion !== expectedDraftVersion) {
            throw new FlowDraftVersionConflictError(String(draft.id), expectedDraftVersion, actualVersion);
        }
        const saved = { ...draft, draftVersion: actualVersion + 1, updatedAt: Date.now() };
        await this.store.writeFile(nodeId, JSON.stringify(saved, null, 2));
        return saved;
    }

    async loadDraft(id: string): Promise<FlowDraft | null> {
        const nodeId = await this.resolveNodeId(id);
        if (!nodeId) return null;
        const content = await this.store.readFile(nodeId);
        return content ? parseFlowDraft(content) : null;
    }

    /** v3 immutable revision boundary with handler/port/cycle validation. */
    async saveRevision(revision: FlowRevision): Promise<FlowRevision> {
        const issues = validateFlowRevision(revision, this.plugins);
        if (hasValidationErrors(issues)) {
            throw new Error(`Invalid FlowRevision: ${issues.map(issue => issue.message).join('; ')}`);
        }
        const computed = flowRevisionDigest(revision);
        if (revision.digest !== computed) {
            throw new Error(`FlowRevision digest mismatch: expected ${computed}, got ${revision.digest}`);
        }
        const nodeId = await this.resolveNodeId(String(revision.id));
        if (!nodeId) throw new Error(`Flow not found: ${revision.id}`);
        const name = revisionName(String(revision.id), revision.revision);
        const existing = await this.readRevision(nodeId, name);
        if (existing) {
            if (existing.digest !== revision.digest) {
                throw new Error(`FlowRevision ${revision.id} r${revision.revision} is immutable`);
            }
            return existing;
        }
        await this.store.createAsset(nodeId, name, JSON.stringify(revision, null, 2));
        await this.store.createAsset(nodeId, latestName(String(revision.id)), JSON.stringify({ revision: revision.revision }));
        return revision;
    }

    async loadRevision(id: string, revision?: number): Promise<FlowRevision | null> {
        const nodeId = await this.resolveNodeId(id);
        if (!nodeId) return null;
        let resolved = revision;
        if (resolved === undefined) {
            resolved = (await this.readAssetJson<{ revision: number }>(nodeId, latestName(id)))?.revision;
        }
        return resolved === undefined ? null : this.readRevision(nodeId, revisionName(id, resolved));
    }

    async listRevisions(id: string): Promise<FlowRevision[]> {
        const nodeId = await this.resolveNodeId(id);
        if (!nodeId) return [];
        const assets = await this.store.listAssets(nodeId);
        const revisions: FlowRevision[] = [];
        for (const asset of assets) {
            const candidate = [asset.path, asset.name].find((value): value is string => Boolean(value));
            if (!candidate) continue;
            const match = candidate.match(/(?:^|\/)revision-(\d+)\.json$/);
            if (!match) continue;
            const loaded = await this.readRevision(nodeId, revisionName(id, Number(match[1])));
            if (loaded && !revisions.some(item => item.revision === loaded.revision)) revisions.push(loaded);
        }
        return revisions.sort((left, right) => left.revision - right.revision);
    }

    async createRevision(draft: FlowDraft): Promise<FlowRevision> {
        const latest = await this.loadRevision(String(draft.id));
        const revision = createFlowRevision(draft, (latest?.revision ?? 0) + 1);
        const { lockFlowDependencies } = await import('./flow/dependency-locks');
        const locks = await lockFlowDependencies(draft, (id, version) => this.loadRevision(id, version));
        if (Object.keys(locks).length) revision.dependencyLocks = locks;
        revision.digest = flowRevisionDigest(revision);
        return this.saveRevision(revision);
    }

    /**
     * Adopt a pre-existing template file (e.g. created by the VFS "+" button)
     * into a valid workflow: assigns a unique, filename-safe id and renames the
     * file to `<id>.flow`, preserving any nodes/edges the template already had.
     */
    async adoptDraft(nodeId: string, name: string): Promise<FlowDraft> {
        const existing = parseFlowDraft(await this.store.readFile(nodeId));
        const id = generateFlowId(name || existing?.name || 'flow');
        const draft: FlowDraft = {
            id: id as FlowDraft['id'],
            draftVersion: (existing?.draftVersion ?? 0) + 1,
            name: name.trim() || existing?.name || id,
            nodes: existing?.nodes ?? [],
            edges: existing?.edges ?? [],
            layout: existing?.layout ?? {},
            parameters: existing?.parameters ?? [],
            ...(existing?.outputs ? { outputs: structuredClone(existing.outputs) } : {}),
            ...(existing?.variables ? { variables: structuredClone(existing.variables) } : {}),
            ...cloneConnections(existing ?? {}),
            ...(existing?.systemPrompt ? { systemPrompt: structuredClone(existing.systemPrompt) } : {}),
            ...(existing?.toolIds ? { toolIds: structuredClone(existing.toolIds) } : {}),
            ...(existing?.defaults ? { defaults: structuredClone(existing.defaults) } : {}),
            ...(existing?.runPolicy ? { runPolicy: structuredClone(existing.runPolicy) } : {}),
            updatedAt: Date.now(),
        };
        await this.store.writeFile(nodeId, JSON.stringify(draft, null, 2));
        await this.store.renameFile(nodeId, fileName(id));
        return draft;
    }

    private async resolveNodeId(id: string): Promise<string | null> {
        return (await this.store.findFile(fileName(id)))?.nodeId ?? null;
    }

    private async readRevision(nodeId: string, name: string): Promise<FlowRevision | null> {
        return this.readAssetJson<FlowRevision>(nodeId, name);
    }

    private async readAssetJson<T>(nodeId: string, name: string): Promise<T | null> {
        const content = await this.store.readAsset(nodeId, name);
        if (content == null) return null;
        const text = typeof content === 'string'
            ? content
            : new TextDecoder().decode(content);
        try {
            return JSON.parse(text) as T;
        } catch {
            return null;
        }
    }
}

function fileName(id: string): string {
    assertFlowId(id);
    return `${id}${FLOW_EXTENSION}`;
}

/** Deep-copy a draft's connection slots so draft/revision copies stay in sync. */
function cloneConnections(source: Pick<FlowDraft, 'connections' | 'defaultConnection'>): {
    connections: FlowConnection[];
    defaultConnection?: string;
} {
    return {
        connections: structuredClone(source.connections ?? []),
        defaultConnection: source.defaultConnection,
    };
}

function revisionName(id: string, revision: number): string {
    assertFlowId(id);
    if (!Number.isInteger(revision) || revision < 1) throw new Error(`Invalid Flow revision: ${revision}`);
    return `revision-${revision}.json`;
}

function latestName(id: string): string {
    assertFlowId(id);
    return 'latest.json';
}

function parseFlowDraft(content: string | null): FlowDraft | null {
    if (!content) return null;
    try {
        return JSON.parse(content) as FlowDraft;
    } catch {
        return null;
    }
}

function assertFlowId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes('..')) {
        throw new Error('Flow ID must use 1-128 letters, numbers, dots, underscores or hyphens');
    }
}

/** Derive an ASCII, filename-safe flow id from a display name + random suffix. */
export function generateFlowId(name: string): string {
    const slug = name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'flow';
    const value = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const suffix = value.replace(/[^a-z0-9-]/g, '').slice(0, 8);
    return `${slug}-${suffix}`;
}

/** Share the complete draft-to-revision projection across validation and publication. */
export function createFlowRevision(draft: FlowDraft, revision: number, createdAt = Date.now()): FlowRevision {
    const withoutDigest = {
        id: draft.id,
        revision,
        name: draft.name,
        nodes: structuredClone(draft.nodes),
        edges: structuredClone(draft.edges),
        parameters: structuredClone(draft.parameters ?? []),
        ...(draft.outputs ? { outputs: structuredClone(draft.outputs) } : {}),
        ...(draft.variables ? { variables: structuredClone(draft.variables) } : {}),
        ...cloneConnections(draft),
        ...(draft.systemPrompt ? { systemPrompt: structuredClone(draft.systemPrompt) } : {}),
        ...(draft.toolIds ? { toolIds: structuredClone(draft.toolIds) } : {}),
        ...(draft.defaults ? { defaults: structuredClone(draft.defaults) } : {}),
        ...(draft.runPolicy ? { runPolicy: structuredClone(draft.runPolicy) } : {}),
        createdAt,
    };
    return { ...withoutDigest, digest: flowRevisionDigest(withoutDigest) };
}
