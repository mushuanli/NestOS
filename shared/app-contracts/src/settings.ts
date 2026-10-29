// @file app-settings/types.ts

// LLM 相关类型直接从 common 导入，避免对 llm-management / llm-runtime 的间接依赖
import type { LLMConnection } from '@itookit/driver-llm/contracts';
import type { MCPServer } from '@itookit/tools/mcp-contracts';

// 向后兼容重新导出
export type { LLMConnection };

export interface Tag {
    id: string;
    name: string;
    color: string;
    description?: string;
    count?: number;
}

export interface Contact {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    company?: string;
    group?: string;
    notes?: string;
}

export interface SettingsState {
    connections: LLMConnection[];
    mcpServers: MCPServer[];
    tags: Tag[];
    contacts: Contact[];
}

import type { IFileSystem } from '@itookit/vfs-core';

/** Host-selected sources for settings export and tag management; names are UI labels, not filesystem roots. */
export interface WorkspaceDescription {
    readonly name: string;
    readonly description?: string;
}

/** A settings source is an authorized view or a persistent workspace identity. */
export type SettingsWorkspaceSource = WorkspaceDescription & { readonly internal?: boolean } & (
    { readonly workspace: string; readonly fs?: never } | { readonly fs: IFileSystem; readonly workspace?: never }
);

export interface WorkspaceFileSource {
    readonly name: string;
    readonly description?: string;
    readonly fs: IFileSystem;
    /**
     * Explicit override for callers that cannot mark the filesystem as external.
     * False excludes the source from tag recording/counting; defaults to true.
     */
    readonly internal?: boolean;
}

export interface LocalSnapshot { name: string; displayName: string; createdAt: number; size: number; description: string }
export interface StorageUsage { usage?: number; quota?: number }
export interface SnapshotPort { estimate?(): Promise<StorageUsage | null>; listLocalSnapshots(): Promise<LocalSnapshot[]>; createSnapshot(): Promise<void>; restoreSnapshot(name: string): Promise<void>; deleteSnapshot(name: string): Promise<void>; factoryReset(): Promise<void> }
export interface SettingsPort {
    estimateStorage(): Promise<StorageUsage | null>;
    readonly workspaces: readonly WorkspaceDescription[];
    openWorkspace(name: string): Promise<IFileSystem>;
    readPreference(path: string): Promise<string>;
    writePreference(path: string, content: string): Promise<void>;
    readonly vfs: import('./ports/files').FileSystemsPort;
    readonly configFiles: IFileSystem;
    dispose(): Promise<void>; onChange(listener: () => void): () => void;
    getContacts(): Contact[]; saveContact(contact: Contact): Promise<void>; deleteContact(id: string): Promise<void>;
    getTags(): Tag[]; syncTags(): Promise<void>; saveTag(tag: Tag): Promise<void>; deleteTag(id: string): Promise<void>;
    exportMixedData(settings: (keyof SettingsState)[], workspaces: string[]): Promise<object>;
    importMixedData(data: unknown, settings: (keyof SettingsState)[], workspaces: string[], options?: { overwrite?: boolean; mergeTags?: boolean }): Promise<void>;
    listLocalSnapshots(): Promise<LocalSnapshot[]>; createSnapshot(): Promise<void>; restoreSnapshot(name: string): Promise<void>; deleteSnapshot(name: string): Promise<void>; factoryReset(): Promise<void>;
    getAvailableSettingsKeys(): (keyof SettingsState)[]; getAvailableWorkspaces(): Array<{ name: string; description?: string }>;
}
