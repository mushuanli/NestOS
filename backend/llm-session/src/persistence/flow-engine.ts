// @file: llm-session/src/persistence/flow-engine.ts
// FlowEngine — the standalone "flows" VFS module backing workflow storage.
// Each workflow is one .flow file (mutable draft); immutable revisions are
// assets under that file. Mirrors SessionRepository's VFS CRUD + asset conventions.

import { FileBackedService } from '../utils/file-backed-service';
import type { IFileSystem } from '@itookit/vfs-core';
import type { FlowFileRef, FlowStore } from '@itookit/llm-flow';

export const FLOW_MODULE_NAME = 'flows';
const FLOW_EXTENSION = '.flow';
const FLOW_ROOT = '/';

export class FlowEngine extends FileBackedService implements FlowStore {
    constructor(fs: IFileSystem) {
        super(fs);
    }

    protected async onLoad(): Promise<void> {}

    // ── FlowStore: file CRUD ────────────────────────────────────────────────

    async listFiles(): Promise<FlowFileRef[]> {
        const nodes = await this.engine.driver.getChildren(FLOW_ROOT);
        return nodes
            .filter(node => node.type === 'file' && node.name.toLowerCase().endsWith(FLOW_EXTENSION))
            .map(node => ({ nodeId: node.path, name: node.name }));
    }

    async findFile(name: string): Promise<FlowFileRef | null> {
        const nodeId = await this.engine.driver.resolvePath(`${FLOW_ROOT}${name}`);
        return nodeId ? { nodeId, name } : null;
    }

    async createFile(name: string, content: string): Promise<FlowFileRef> {
        const node = await this.engine.driver.createFile({ name, parentPath: FLOW_ROOT, content });
        return { nodeId: node.path, name: node.name };
    }

    async readFile(nodeId: string): Promise<string | null> {
        try {
            const content = await this.engine.driver.readContent(nodeId);
            if (content == null) return null;
            return typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer);
        } catch {
            return null;
        }
    }

    async writeFile(nodeId: string, content: string): Promise<void> {
        await this.engine.driver.writeContent(nodeId, content);
    }

    async renameFile(nodeId: string, newName: string): Promise<void> {
        await this.engine.driver.rename(nodeId, newName);
    }

    async deleteFile(nodeId: string): Promise<void> {
        await this.engine.driver.delete([nodeId]);
    }

    // ── FlowStore: assets (revisions) ───────────────────────────────────────

    async createAsset(
        ownerNodeId: string,
        filename: string,
        content: string | ArrayBuffer,
    ): Promise<unknown> {
        return this.engine.meta.assets.putAsset(ownerNodeId, filename, content);
    }

    async readAsset(
        ownerNodeId: string,
        filename: string,
    ): Promise<string | ArrayBuffer | null> {
        const content = await this.engine.meta.assets.getAsset(ownerNodeId, filename);
        return content == null ? null : normalizeContent(content);
    }

    async listAssets(ownerNodeId: string): Promise<Array<{ path?: string; name?: string }>> {
        const path = await this.engine.meta.assets.getAssetDirPath(ownerNodeId);
        if (!path) return [];
        const children = await this.engine.driver.getChildren(path);
        return children.map(node => ({ path: node.path, name: node.name }));
    }
}

function normalizeContent(content: unknown): string | ArrayBuffer {
    if (typeof content === 'string' || content instanceof ArrayBuffer) return content;
    const bytes = content as Uint8Array;
    return new Uint8Array(bytes).buffer;
}
