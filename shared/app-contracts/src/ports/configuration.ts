/** Shared application capabilities; implementations belong to backend/app-core. */
import type * as VfsContracts from '@itookit/vfs-core';
import type { IFileSystem } from '@itookit/vfs-core';
import type { ToolDefinition } from '@itookit/llm-context';
import type { LLMProvider, ConnectionMeta, ModelTier } from '@itookit/driver-llm/contracts';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import type { ToolMeta } from '@itookit/tools/contracts';
import type { DrawerKind, Drawer, ToolboxKind } from '../index';
import type { RemoteHarnessAgent } from './projects';

export interface ToolboxTool {
    id: string;
    name: string;
    description: string;
    source: string;
    serverId?: string;
    enabled: boolean;
    parameters?: unknown;
}

/** Backend-prepared navigation metadata; source capabilities retain write ownership. */
export interface ToolboxNavigation {
    directories: Array<import('./navigation').NavigationDirectory & { path: string }>;
    loadedDirectories: string[];
    descriptions: Map<string, { name: string; description?: string }>;
}

export interface ToolboxResources {
    navigation(): Promise<ToolboxNavigation>;
    readonly sources: Record<ToolboxKind, IFileSystem>;
    readonly drawers: ToolboxDrawers;
    subscribe(listener: () => void): () => void;
    setDefaultConnection(id: string | null): Promise<void>;
    toolGrant: typeof toolGrant;
    getAgents(): Promise<AgentDefinition[]>;
    hasProvider(id: string): boolean;
    setToolGrant(tool: ToolGrantTarget, agentId: string, enabled: boolean): Promise<void>;
    create(kind: ToolboxKind, name: string, providerId?: string): Promise<string>;
    createInDrawer(kind: ToolboxKind, name: string, drawer: string, providerId?: string): Promise<string>;
    export(paths: string[], drawers?: Array<{
        kind: DrawerKind;
        name: string;
    }>): Promise<string>;
    import(content: string): Promise<string[]>;
}

export interface ToolGrantTarget {
    id: string;
    serverId?: string;
}

export declare function toolGrant(tool: ToolGrantTarget, agent: AgentDefinition): {
    readonly key: "toolIds" | "mcpProfileIds";
    readonly id: string;
    readonly ids: readonly string[];
};

export interface ToolboxDrawers {
    snapshot(): readonly Drawer[];
    get(id: string): Drawer | undefined;
    list(kind: DrawerKind): Drawer[];
    forPath(resource: string): Drawer | undefined;
    assign(entries: Array<{
        path: string;
        name: string;
    }>, empty?: Array<{
        kind: DrawerKind;
        name: string;
    }>, options?: {
        restoreNames?: boolean;
    }): Promise<void>;
    relocate(kind: DrawerKind, nodes: Array<{
        oldPath: string;
        newPath: string;
    }>): Promise<void>;
    create(kind: DrawerKind, name: string): Promise<void>;
    rename(group: Drawer, name: string): Promise<void>;
    remove(group: Drawer): Promise<void>;
}

export interface ToolboxInventory {
    readonly remoteAgents: Map<string, RemoteHarnessAgent>;
    readonly remoteAgentSource: VfsContracts.IFileSystem;
    readonly providers: Map<string, {
        id: string;
        name: string;
        icon?: string;
        enabled: boolean;
        configured: boolean;
        authentication?: 'chatgpt';
        authorizationAvailable?: boolean;
    }>;
    readonly connections: Map<string, {
        providerId: string;
        enabled: boolean;
    }>;
    defaultConnectionId?: string;
    readonly tools: Map<string, ToolboxTool>;
    readonly sources: {
        prompts: VfsContracts.IFileSystem;
        mcp: VfsContracts.IFileSystem;
        tools: VfsContracts.IFileSystem;
        providers: VfsContracts.IFileSystem;
        connections: VfsContracts.IFileSystem;
    };
}

export interface ProviderDeletionImpact {
    revision: string;
    providers: LLMProvider[];
    connections: ConnectionMeta[];
}

export interface MCPDeletedProject {
    id: string;
    name: string;
    path: string;
    localSessions: Array<{
        id: string;
        title: string;
    }>;
}

export interface MCPDeletionReference {
    connectionId: string;
    projectId: string;
    mountId: string;
    at: string;
    revision: number;
}

export interface OcrService {
    readSettings(): Promise<OcrSettings>;
    prepareConfiguration(): Promise<void>;
    preparePromptEditor(): Promise<string>;
    subscribe(listener: () => void): () => void;
    connections(): Promise<OcrConnection[]>;
    save(settings: OcrSettings): Promise<void>;
    label(): Promise<string>;
    ready(): Promise<boolean>;
    recognize(image: Blob, signal?: AbortSignal): Promise<string>;
}

export interface OcrSettings {
    connectionId?: string;
    systemPromptId: string;
}

export interface OcrConnection {
    connection: ConnectionMeta;
    modelId?: string;
    tier?: ModelTier;
    available: boolean;
    reason?: string;
}

export interface ModelConfigurationCommands {
    mcpDeletion?: MCPDeletionPort;
    inspectProviderDeletion(ids: readonly string[]): Promise<ProviderDeletionImpact>;
    discardPlan(revision: string): void;
    inspectMCPDeletion(ids: readonly string[]): Promise<MCPDeletionImpact>;
    deleteMCPServers(input: {
        revision: string;
        force: boolean;
    }): Promise<void>;
    deleteProviders(input: {
        revision: string;
    }): Promise<void>;
    deleteResources(target: {
        kind: 'connections' | 'mcp' | 'prompts';
        ids: readonly string[];
    }): Promise<void>;

}

export interface MCPDeletionImpact {
    revision: string;
    ids: string[];
    servers: Array<{
        id: string;
        name: string;
    }>;
    references: MCPDeletionReference[];
    projects: MCPDeletedProject[];
}

export interface MCPDeletionPort {
    reconcileMCPReferences?(): Promise<void>;
    mcpReferences(ids: readonly string[]): MCPDeletionReference[] | Promise<MCPDeletionReference[]>;
    inspectRemoteProjects?(ids: readonly string[]): Promise<MCPDeletedProject[]>;
    removeMCPReferences(ids: readonly string[], expected: readonly MCPDeletionReference[], projectIds?: readonly string[]): Promise<void>;
}

export interface Catalog {
    listTools(): ToolMeta[];
    getToolDefinitions(): ToolDefinition[];
}
