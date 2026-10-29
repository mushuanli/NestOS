import { validateLLMIoctlArgument, isConnection, isStoredProvider, isMCPServer, isChatMessage } from './argument-validation';
import { snapshotMCPConnectionOptions, type MCPConnectionOptions } from '../contracts/mcp-transport';
import type { ProviderConnectionTestParams } from '@itookit/driver-llm/contracts';
import { listProviderModels } from '@itookit/driver-llm';
import {completeModelDeclaration} from '../contracts/model-declarations';
import { ProviderAuthorization } from './provider-authorization';
import type { ProviderAuthorizationHost } from '../contracts/provider-authorization';
// @file: kernel-adapters/llm-management/device/llm-device-driver.ts
//
// LLMDeviceDriver — LLM 连接配置守护者 + LLM/MCP/Skill 通信设备。
//
// 职责：
//  1. 管理 LLMConnection 存储（VFS __config 模块 /llm/.connections/）
//  2. 管理 MCPServer 存储（VFS __config 模块 /llm/.mcp/）
//  3. 管理 LLMSkill 存储（VFS __config 模块 /llm/.skills/）
//  4. 对外暴露 ConnectionMeta（无 apiKey）供 AgentExecutor 等使用
//  5. 通过 ioctl 为 Settings UI 提供 CRUD
//  6. 维护 Chat / MCP / Skill Session 生命周期
//  7. 创建 /dev/llm/connection/<id>、/dev/llm/mcp/<id>、/dev/llm/skills/<id> 设备节点

import type { ILLMManagementService, LLMSkill, InitialAgentDef } from '@itookit/kernel-adapters/contracts';
import type { LLMConnection, LLMProvider, ConnectionMeta, MediaGenerationRequest, ChatCompletionChunk, ChatCompletionParams, ChatCompletionResponse, TokenUsage, ConnectionTestResult } from '@itookit/driver-llm/contracts';
import type { ChatMessage } from '@itookit/llm-context';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import type { ToolDefinition } from '@itookit/tools/contracts';
import type {
    IDeviceDriver, DeviceContext, IVFSManager, FileContent, IFileSystem,
} from '@itookit/vfs-core';

import { LLMDriver } from '@itookit/driver-llm';
import { testLLMConnection } from '@itookit/driver-llm';
import type { CodexAppServerTransport, CodexCLIConfig, CodexCommandRunner } from '@itookit/driver-llm';
import { snapshotLlmPresets, type LlmManagementPresets, type ProviderConnectionPolicy } from '../contracts/presets';
import { CostStore } from '../cost/cost-store';
import { SystemPromptStore } from './system-prompt-store';
import type { MCPToolInfo } from '../skills/mcp-client';

import { VFSHelpers } from './vfs-helpers';
import { CostManager } from './cost-manager';
import { ProviderManager } from './provider-manager';
import { ConnectionManager } from './connection-manager';
import type { ModelDefaults, ModelOperation } from '../contracts/model-defaults';
import { MCPManager } from './mcp-manager';
import { SkillManager } from './skill-manager';

// ─── 存储路径 ────────────────────────────────────────────────────────────────
const CONNECTIONS_DIR  = '/llm/.connections';       // LLM 连接（新路径）
const PROVIDERS_DIR    = '/llm/.providers';         // Provider 配置（用户自定义 + 内置覆盖）
const MCP_DIR          = '/llm/.mcp';               // MCP 服务器配置（新路径）

// ─── ioctl 命令 ───────────────────────────────────────────────────────────────

import { LLM_IOCTL } from '../contracts/device';
export { LLM_IOCTL, type LLMIoctlCommand } from '../contracts/device';


// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Replace path separators and other problematic chars for a log-friendly filename */
function sanitizeLabel(label: string): string {
    return label
        .replace(/[\\/]/g, '_')   // / and \ → _
        .replace(/[^a-zA-Z0-9_.-]/g, '_') // other special chars → _
        .replace(/_+/g, '_')       // collapse runs
        .replace(/^_|_$/g, '')     // trim leading/trailing _
        .slice(0, 80);             // cap length
}

/** Device nodes are independent VFS entries; bounded batches overlap their round trips. */
const DEVICE_NODE_BATCH = 8;
async function inBatches<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
    for (let start = 0; start < items.length; start += DEVICE_NODE_BATCH) {
        await Promise.all(items.slice(start, start + DEVICE_NODE_BATCH).map(run));
    }
}

// ─── 公共接口 ─────────────────────────────────────────────────────────────────

/** open() options（LLM session） */
export interface LLMDeviceOpenOptions {
    connectionId: string;
    systemPrompt?: string;
    completionDefaults?: Record<string, unknown>;
    /** 调用方的运行模式；kernel 强制走 anthropic-messages 协议。 */
    runMode?: 'kernel';
    /** 日志文件名标签（如聊天文件名），将转义后用于 /var/log/llm/{label}.json */
    sessionLabel?: string;
}

// Management contracts are owned by kernel-adapters/contracts.

// ─── 内部会话状态 ─────────────────────────────────────────────────────────────

interface LLMSessionState {
    readonly id: string;
    readonly kind: 'llm';
    readonly driver: LLMDriver;
    readonly connection: LLMConnection;
    readonly completionDefaults: Record<string, unknown>;
    history: ChatMessage[];
    pendingStream: AsyncGenerator<ChatCompletionChunk> | null;
    lastResponse: string | null;
    lastUsage: TokenUsage | null;
    abortController: AbortController | null;
}

interface MCPSessionState {
    readonly kind: 'mcp';
    readonly connection: import('../skills/mcp-client').MCPServerConnection;
    readonly server: MCPServer;
}

interface SkillSessionState {
    readonly kind: 'skill';
    readonly skill: LLMSkill;
}

type SessionState = LLMSessionState | MCPSessionState | SkillSessionState;

// ─── Shell Runner interface ──────────────────────────────────────────────────
//
// 执行环境隔离层。llm-management 运行在浏览器环境，不能直接访问 child_process。
// 不同宿主环境注入各自的实现：
//   - 浏览器:    不注入 → shell skills 返回"不支持"提示
//   - Tauri:     TauriShellRunner（@tauri-apps/plugin-shell）
//   - Node.js:   NodeShellRunner（由 kernel-adapters 提供）
//
export interface IShellRunner {
    /** 执行 shell 命令，返回 stdout+stderr 合并输出 */
    run(command: string, args: Record<string, unknown>): Promise<string>;
}

// ─── LLMDeviceDriver ─────────────────────────────────────────────────────────

export interface LLMDeviceDriverOptions {
    configurationReadonly?: boolean;
    configurationFileSystem?: IFileSystem;
    costFileSystem?: IFileSystem;
    /** Diagnostics only; request bodies and credentials never enter this sink. */
    logger?: import('@itookit/driver-llm/contracts').LLMLogSink;
    providerAuthorization?: ProviderAuthorizationHost;
    providerFactory?: import('@itookit/driver-llm/contracts').ProviderFactory;
    mediaAdapterFactory?: import('@itookit/driver-llm/contracts').MediaAdapterFactory;
    mcp?: MCPConnectionOptions;
    presets?: Partial<LlmManagementPresets>;
    providerConnectionPolicy?: ProviderConnectionPolicy;
    /**
     * Shell 命令执行器（可选）。
     * 未注入时 shell 类型 Skill 返回"环境不支持"提示。
     */
    shellRunner?: IShellRunner;

    /** Runner for the local `codex exec` provider. */
    codexRunner?: CodexCommandRunner;
    /** Preferred persistent Codex app-server transport. */
    codexTransport?: CodexAppServerTransport;

    /**
     * LLM 流量日志记录器（可选）。
     * Web 环境注入 NoopLLMLogger，Tauri 环境注入 FileLogger。
     */
    llmLogger?: import('@itookit/driver-llm/contracts').ILLMLogger;
}

export class LLMDeviceDriver implements IDeviceDriver, ILLMManagementService {
    private readonly mcpOptions: MCPConnectionOptions;
    private readonly presets: LlmManagementPresets;
    private readonly providerConnectionPolicy?: ProviderConnectionPolicy;
    readonly handlerId = 'llm';
    readonly description = 'LLM streaming chat, connection management, MCP, and skills device';
    readonly writable = true;
    readonly streamable = true;
    readonly sessionable = true;

    // ── Sessions ──
    private readonly sessions = new Map<string, SessionState>();
    private sessionSeq = 0;

    // ── Listener / timer state ──
    private _listeners = new Set<() => void>();
    private _syncTimer: ReturnType<typeof setTimeout> | null = null;
    private _eventUnsubs: Array<() => void> = [];

    private readonly configurationFileSystem?: IFileSystem;
    private readonly configurationReadonly: boolean;
    private readonly costFileSystem?: IFileSystem;
    private engine!: import('@itookit/vfs-core').IFileSystem;
    private readonly shellRunner: IShellRunner | undefined;
    private readonly codexRunner: CodexCommandRunner | undefined;
    private readonly codexTransport: CodexAppServerTransport | undefined;
    private readonly mediaAdapterFactory?: import('@itookit/driver-llm/contracts').MediaAdapterFactory;
    private readonly providerFactory?: import('@itookit/driver-llm/contracts').ProviderFactory;
    private readonly llmLogger: import('@itookit/driver-llm/contracts').ILLMLogger | undefined;
    private readonly logger?: import('@itookit/driver-llm/contracts').LLMLogSink;

    // ── Managers (initialised in init()) ──
    private vfsHelpers!: VFSHelpers;
    private costManager!: CostManager;
    private providerManager!: ProviderManager;
    private connectionManager!: ConnectionManager;
    private mcpManager!: MCPManager;
    private skillManager!: SkillManager;

    /**
     * Resolve the system access for /etc hidden-file operations.
     * Prefers ctx.systemAccess (injected by openDevice) over the local engine.
     */
    private getSystemFS(_ctx?: DeviceContext): IFileSystem {
        // ctx.systemAccess is ISystemAccess but for internal consumers that need
        // IFileSystem, fall back to the local etc engine (which writes to /etc/).
        return this.engine;
    }

    constructor(private readonly vfs: IVFSManager, options?: LLMDeviceDriverOptions) {
        this.configurationFileSystem = options?.configurationFileSystem;
        this.configurationReadonly = options?.configurationReadonly ?? false;
        this.costFileSystem = options?.costFileSystem;
        this.logger = options?.logger;
        this.authorization = new ProviderAuthorization(options?.providerAuthorization, id => this.getFullProvider(id));
        if (options?.providerAuthorization) this._eventUnsubs.push(options.providerAuthorization.onChange(() => this.notify()));
        this.mcpOptions = snapshotMCPConnectionOptions(options?.mcp);
        this.presets = snapshotLlmPresets(options?.presets);
        this.providerConnectionPolicy = options?.providerConnectionPolicy;
        this.shellRunner = options?.shellRunner;
        this.providerFactory = options?.providerFactory;
        this.mediaAdapterFactory = options?.mediaAdapterFactory;
        this.codexRunner = options?.codexRunner;
        this.codexTransport = options?.codexTransport;
        this.llmLogger = options?.llmLogger;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    private initialization?: Promise<void>;
    private readonly authorization: ProviderAuthorization;
    private disposed = false;
    private autoConnections = new Set<Promise<unknown>>();
    init(): Promise<void> {
        if (this.disposed) return Promise.reject(new Error('LLM driver is disposed'));
        return this.initialization ??= this.initialize();
    }
    ensureReady(): Promise<void> { return this.init(); }
    /** Join the initial bounded connection attempts without changing interactive readiness. */
    async waitForMCPStartup(): Promise<void> {
        await this.ensureReady();
        await Promise.allSettled([...this.autoConnections]);
    }
    ready(): Promise<void> { return this.createDeviceNodes(); }

    private async initialize(): Promise<void> {
        const t0 = performance.now();
        let t = t0;
        const _log = (label: string) => {
            const now = performance.now();
            console.log(`[Boot]     ↳ llm.${label}: +${(now - t).toFixed(0)}ms`);
            t = now;
        };

        // /etc is a rootfs built-in directory — no mount() needed.
        this.engine = this.configurationFileSystem ?? await this.vfs.openFileSystem('/etc');
        _log('openConfigFiles');

        // Initialise helpers first (no async deps)
        this.vfsHelpers = new VFSHelpers(this.engine);
        this.providerManager = new ProviderManager(this.engine, this.vfsHelpers, () => this.notify(), this.presets);
        this.connectionManager = new ConnectionManager(this.vfsHelpers, this.vfs, this.providerManager, () => this.notify(), this.presets, this.providerConnectionPolicy,
            id => this.getFullProvider(id)?.implementation === 'chatgpt' ? this.authorization.state(id).status === 'authorized' : undefined, this.logger);
        this.mcpManager = new MCPManager(this.vfsHelpers, this.vfs, () => this.notify(), this.mcpOptions);
        this.skillManager = new SkillManager(this.vfsHelpers, this.vfs, this.mcpManager, this.shellRunner, () => this.notify());

        // Pre-load all data directories in parallel
        const [preProviders, preConnections, preMcps, preSkills] = await Promise.all([
            this.vfsHelpers.loadJsonFilesFromDir<LLMProvider>(PROVIDERS_DIR, undefined, isStoredProvider),
            this.vfsHelpers.loadJsonFilesFromDir<LLMConnection>(CONNECTIONS_DIR, undefined, isConnection),
            this.vfsHelpers.loadJsonFilesFromDir<MCPServer>(MCP_DIR, undefined, isMCPServer),
            this.skillManager.loadAllSkills(),
        ]);
        _log('preloadDirs');

        // These stores have independent files; publish readiness after every task settles.
        const stores = await Promise.allSettled([
            this.providerManager.loadPricing(), this.initializeCostStore(), this.initializePromptStore(),
        ]);
        const failedStores = stores.filter(result => result.status === 'rejected');
        if (failedStores.length) throw new AggregateError(failedStores.map(result => result.reason), 'LLM stores failed to initialize');
        _log('configStores');

        // Sync default providers, then merge into cache
        if (!this.configurationReadonly) await this.providerManager.syncDefaultProviders(preProviders);
        _log('syncDefaultProviders');
        this.providerManager.reloadProvidersFrom(preProviders);
        _log('reloadProviders');

        // Sync default connections, then cache
        const updatedConns = this.configurationReadonly ? preConnections : await this.connectionManager.ensureDefaultsWith(preConnections);
        _log('ensureDefaults');
        this.connectionManager.setConnections(updatedConns);
        await this.connectionManager.loadSettings();
        _log('reload');

        // Cache MCP & skills from pre-loaded data
        this.mcpManager.setServers(preMcps);
        _log('reloadMCP');
        this.skillManager.setSkills(preSkills);
        _log('reloadSkills');

        for (const server of preMcps) if (server.autoConnect !== false) this.autoConnect(server);

        // Cross-tab sync
        this.bindVFSEvents();
        console.log(`[Boot]     ↳ llm.init total: ${(performance.now() - t0).toFixed(0)}ms`);
        this.notify();
    }

    private async initializeCostStore(): Promise<void> {
        const store = new CostStore(this.costFileSystem ?? this.engine);
        await store.ensureFile();
        this.costManager = new CostManager(store);
    }

    private async initializePromptStore(): Promise<void> {
        const store = new SystemPromptStore(this.engine, this.presets.agents);
        await store.ensureFile();
        if (!this.configurationReadonly) await store.seedDefaults();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.initialization?.catch(() => {});
        await this.deviceNodes?.catch(() => {});
        await Promise.allSettled(this.autoConnections);
        this._eventUnsubs.forEach(fn => fn());
        this._eventUnsubs = [];
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        this._listeners.clear();

        // Abort and release all LLM sessions (Codex app-server subprocesses etc.)
        await Promise.all([...this.sessions.values()]
            .filter((s): s is LLMSessionState => s.kind === 'llm')
            .map(async s => {
                s.abortController?.abort();
                await s.driver.dispose();
            }));

        // Disconnect all active MCP connections
        await this.mcpManager?.disconnectAll();
        this.sessions.clear();
    }

    // ─── createDeviceNodes ────────────────────────────────────────────────────

    /**
     * 在 VFS 中建立 /dev/llm/ 目录树并创建设备文件。
     */
    private deviceNodes?: Promise<void>;
    createDeviceNodes(): Promise<void> {
        return this.deviceNodes ??= this.populateDeviceNodes();
    }
    private async populateDeviceNodes(): Promise<void> {
        await this.ensureReady();
        if (this.disposed) return;
        // 建父目录（普通目录，不是 device 文件）
        await this.vfs.ensureSystemDirectory('/dev/llm');
        await Promise.all(['/dev/llm/connection', '/dev/llm/mcp', '/dev/llm/skills']
            .map(path => this.vfs.ensureSystemDirectory(path)));

        // Connection device files
        await inBatches(this.connectionManager.getRawConnections(), conn => this.vfs.createDeviceNode('llm', `/dev/llm/connection/${conn.id}`, {
            resourceType: 'connection',
            resourceId: conn.id,
        }));

        // MCP device files
        for (const server of this.mcpManager.getRawServers()) {
            await this.vfs.createDeviceNode('llm', `/dev/llm/mcp/${server.id}`, {
                resourceType: 'mcp',
                resourceId: server.id,
            });
        }

        // Skill device files
        await inBatches(this.skillManager.getRawSkills(), skill => this.vfs.createDeviceNode('llm', `/dev/llm/skills/${skill.id}`, {
            resourceType: 'skill',
            resourceId: skill.id,
        }));
    }

    private autoConnect(server: MCPServer): void {
        const target = server.transport === 'stdio' ? server.command : server.endpoint;
        if (this.disposed || !target?.trim() || (server.transport === 'stdio' && !this.supportsMCPStdio())) return;
        const started = performance.now();
        const metadata = {operation: 'mcp.startup', operationId: server.id, serverId: server.id, transport: server.transport};
        this.mcpOptions.logger?.info('MCP startup connection started', {...metadata, stage: 'connect'});
        const work = this.mcpManager.initializeMCPServer(server.id);
        this.autoConnections.add(work);
        void work.then(ready => { if (ready) this.mcpOptions.logger?.info('MCP startup connection ready', {...metadata, stage: 'complete', outcome: 'success', durationMs: Math.round(performance.now() - started)}); })
            .catch(() => {
                const issue = this.mcpManager.getMCPServers().find(item => item.id === server.id)?.connectionState?.issues[0];
                const details = {...metadata, stage: issue?.stage ?? 'connect', outcome: 'failure',
                    code: `MCP_${(issue?.reason ?? 'unknown').toUpperCase()}`, durationMs: Math.round(performance.now() - started)};
                if (this.mcpOptions.logger) this.mcpOptions.logger.warn('MCP startup connection failed', details);
                else console.warn('[LLMDeviceDriver] MCP startup connection failed', details);
            })
            .finally(() => this.autoConnections.delete(work));
    }

    // ─── IDeviceDriver: open / close ─────────────────────────────────────────

    async open(ctx: DeviceContext, options?: Record<string, unknown>): Promise<string> {
        await this.ensureReady();
        const resourceType = (ctx.metadata?.resourceType ?? options?.resourceType) as string | undefined;
        const resourceId   = (ctx.metadata?.resourceId   ?? options?.resourceId)   as string | undefined;

        if (resourceType === 'connection') {
            return this.openConnectionSession(resourceId ?? this.connectionManager.getDefaultConnection()?.id, options);
        }
        if (resourceType === 'mcp') {
            if (!resourceId) throw new Error('LLMDeviceDriver: resourceId required for MCP session');
            return this.openMCPSession(resourceId, options);
        }
        if (resourceType === 'skill') {
            if (!resourceId) throw new Error('LLMDeviceDriver: resourceId required for Skill session');
            return this.openSkillSession(resourceId);
        }

        // Legacy: openDevice('/dev/llm', { connectionId: 'xxx' })
        const opts = options as LLMDeviceOpenOptions | undefined;
        return this.openConnectionSession(opts?.connectionId ?? this.connectionManager.getDefaultConnection()?.id, options);
    }

    async close(ctx: DeviceContext): Promise<void> {
        const session = this.sessions.get(ctx.sessionId!);
        if (!session) return;
        if (session.kind === 'llm') {
            session.abortController?.abort();
            await session.driver.dispose();
        }
        this.sessions.delete(ctx.sessionId!);
    }

    // ─── IDeviceDriver: I/O ──────────────────────────────────────────────────

    async write(ctx: DeviceContext, content: FileContent): Promise<void> {
        const session = this.requireLLMSession(ctx);
        session.abortController?.abort();
        session.pendingStream = null;

        const abort = new AbortController();
        session.abortController = abort;
        const msg = this.decodeMessage(content);
        session.history.push(msg);

        if (msg.role === 'user' || msg.role === 'system') {
            this.llmLogger?.logMessage(session.id, msg.role, this.extractContent(msg));
        }
        this.llmLogger?.logRequest(session.id, {
            provider: session.driver.providerName,
            model: session.driver.currentModel ?? '',
            messages: session.history,
            params: session.completionDefaults,
        });

        const rawStream = await session.driver.chat.create({
            ...session.completionDefaults,
            messages: session.history,
            stream: true,
            signal: abort.signal,
        });
        session.pendingStream = this.wrapAccumulate(session, rawStream);
    }

    async *readStream(ctx: DeviceContext): AsyncIterable<string | ArrayBuffer> {
        const session = this.requireLLMSession(ctx);
        if (!session.pendingStream) return;
        const gen = session.pendingStream;
        session.pendingStream = null;
        for await (const chunk of gen) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) yield delta;
        }
    }

    async read(ctx: DeviceContext): Promise<FileContent> {
        const session = this.requireLLMSession(ctx);
        if (session.pendingStream) {
            const gen = session.pendingStream;
            session.pendingStream = null;
            for await (const _ of gen) { /* drain */ }
        }
        return session.lastResponse ?? '';
    }

    // ─── IDeviceDriver: ioctl ────────────────────────────────────────────────
    async ioctl(ctx: DeviceContext, command: string | number, arg?: unknown): Promise<unknown> {
        validateLLMIoctlArgument(command, arg);
        await this.ensureReady();
        if (typeof command === 'string' && Object.hasOwn(this.managementIoctl, command)) {
            return this.managementIoctl[command as keyof typeof this.managementIoctl]!(ctx, arg);
        }
        const session = this.sessions.get(ctx.sessionId!);
        if (session?.kind === 'mcp')
            return this.mcpIoctl(session, command, arg);
        if (session?.kind === 'skill')
            return this.skillIoctl(session, command, arg);
        return this.chatIoctl(this.requireLLMSession(ctx), command, arg);
    }

    private readonly managementIoctl: Readonly<Partial<Record<(typeof LLM_IOCTL)[keyof typeof LLM_IOCTL], (ctx: DeviceContext, arg?: unknown) => Promise<unknown>>>> = Object.freeze({
        [LLM_IOCTL.LIST_CONNECTIONS]: async (_ctx, _arg) => {
            return this.connectionManager?.listConnections() ?? [];
        },
        [LLM_IOCTL.GET_CONNECTION_META]: async (_ctx, arg) => {
            return this.connectionManager.getConnection(arg as string) ?? null;
        },
        [LLM_IOCTL.GET_DEFAULT_CONNECTION]: async (_ctx, _arg) => {
            return this.connectionManager.getDefaultConnection();
        },
        [LLM_IOCTL.GET_FULL_CONNECTION]: async (_ctx, arg) => {
            return this.connectionManager.getFullConnection(arg as string);
        },
        [LLM_IOCTL.SAVE_CONNECTION]: async (ctx, arg) => {
            await this.saveConnection(arg as LLMConnection, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.DELETE_CONNECTION]: async (ctx, arg) => {
            await this.deleteConnection(arg as string, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.TEST_CONNECTION_PARAMS]: async (_ctx, arg) => {
            return this.testConnection(arg as Parameters<LLMDeviceDriver['testConnection']>[0]);
        },
        [LLM_IOCTL.LIST_MCP_SERVERS]: async (_ctx, _arg) => {
            return this.mcpManager.getMCPServers();
        },
        [LLM_IOCTL.SAVE_MCP_SERVER]: async (ctx, arg) => {
            await this.mcpManager.saveMCPServer(arg as MCPServer, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.DELETE_MCP_SERVER]: async (ctx, arg) => {
            await this.mcpManager.deleteMCPServer(arg as string, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.CONNECT_MCP_SERVER]: async (_ctx, arg) => {
            {
                const server = this.mcpManager.getRawServers().find(s => s.id === (arg as string));
                if (server)
                    await this.mcpManager.connectMCPServer(server);
                return;
            }
        },
        [LLM_IOCTL.DISCONNECT_MCP_SERVER]: async (_ctx, arg) => {
            {
                await this.mcpManager.disconnectServer(arg as string);
                return;
            }
        },
        [LLM_IOCTL.LIST_PROVIDERS]: async (_ctx, _arg) => {
            return this.providerManager?.getProviders() ?? [];
        },
        [LLM_IOCTL.GET_PROVIDER]: async (_ctx, arg) => {
            return this.providerManager.getProvider(arg as string) ?? null;
        },
        [LLM_IOCTL.GET_FULL_PROVIDER]: async (_ctx, arg) => {
            return this.providerManager.getFullProvider(arg as string) ?? null;
        },
        [LLM_IOCTL.SAVE_PROVIDER]: async (ctx, arg) => {
            await this.saveProvider(arg as LLMProvider, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.DELETE_PROVIDER]: async (ctx, arg) => {
            await this.providerManager.deleteProvider(arg as string, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.LIST_SKILLS]: async (_ctx, _arg) => {
            return this.skillManager.getSkills();
        },
        [LLM_IOCTL.SAVE_SKILL]: async (ctx, arg) => {
            await this.saveSkill(arg as LLMSkill, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.DELETE_SKILL]: async (ctx, arg) => {
            await this.deleteSkill(arg as string, this.getSystemFS(ctx));
            return;
        },
        [LLM_IOCTL.QUERY_COSTS_BY_SESSION]: async (_ctx, arg) => {
            return this.costManager.queryBySession(arg as string);
        },
        [LLM_IOCTL.QUERY_COSTS_BY_PROVIDER]: async (_ctx, arg) => {
            {
                const f = arg as {
                    providerId: string;
                    dateFrom?: string;
                    dateTo?: string;
                };
                return this.costManager.queryAll({ providerId: f.providerId, dateFrom: f.dateFrom, dateTo: f.dateTo });
            }
        },
        [LLM_IOCTL.QUERY_COSTS_ALL]: async (_ctx, arg) => {
            return this.costManager.queryAll(arg as {
                providerId?: string;
                dateFrom?: string;
                dateTo?: string;
            } | undefined);
        }
    });

    private async mcpIoctl(session: MCPSessionState, command: string | number, arg?: unknown): Promise<unknown> {
        switch (command) {
            case LLM_IOCTL.MCP_DISCOVER: return session.connection.discover();
            case LLM_IOCTL.MCP_READ_RESOURCE: {
                const { uri, signal } = arg as {
                    uri: string;
                    signal?: AbortSignal;
                };
                return session.connection.readResource(uri, { signal });
            }
            case LLM_IOCTL.MCP_GET_PROMPT: {
                const { name, args, signal } = arg as {
                    name: string;
                    args?: Record<string, string>;
                    signal?: AbortSignal;
                };
                return session.connection.getPrompt(name, args, { signal });
            }
            case LLM_IOCTL.MCP_LIST_TOOLS: {
                const tools = await session.connection.listTools();
                return tools.map((t: MCPToolInfo): ToolDefinition => ({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema,
                    },
                }));
            }
            case LLM_IOCTL.MCP_CALL_TOOL: {
                const { tool, args, ...options } = arg as {
                    tool: string;
                    args: Record<string, any>;
                    timeout?: number;
                    signal?: AbortSignal;
                    onProgress?: (progress: {
                        progress: number;
                        total?: number;
                        message?: string;
                    }) => void;
                };
                return session.connection.callTool(tool, args, options);
            }
            default:
                throw new Error(`LLMDeviceDriver: unknown MCP ioctl '${String(command)}'`);
        }
    }

    private async skillIoctl(session: SkillSessionState, command: string | number, arg?: unknown): Promise<unknown> {
        switch (command) {
            case LLM_IOCTL.SKILL_GET_DEF:
                return session.skill;
            case LLM_IOCTL.SKILL_INVOKE: {
                const { args } = arg as {
                    args: Record<string, unknown>;
                };
                return this.skillManager.invokeSkill(session.skill, args);
            }
            default:
                throw new Error(`LLMDeviceDriver: unknown Skill ioctl '${String(command)}'`);
        }
    }

    private async chatIoctl(llmSession: LLMSessionState, command: string | number, arg?: unknown): Promise<unknown> {
        switch (command) {
            case LLM_IOCTL.MEDIA_GENERATE: return llmSession.driver.generateMedia(arg as MediaGenerationRequest);
            case LLM_IOCTL.CHAT: return this.streamChat(llmSession, arg as ChatCompletionParams);
            case LLM_IOCTL.CHAT_SYNC: {
                const params = arg as ChatCompletionParams;
                return llmSession.driver.chat.create({ ...params, stream: false }) as Promise<ChatCompletionResponse>;
            }
            case LLM_IOCTL.GET_HISTORY:
                return llmSession.history.slice();
            case LLM_IOCTL.CLEAR_HISTORY:
                llmSession.abortController?.abort();
                llmSession.pendingStream = null;
                llmSession.lastResponse = null;
                llmSession.lastUsage = null;
                llmSession.history = llmSession.history.filter(m => m.role === 'system');
                return;
            case LLM_IOCTL.GET_MODELS: {
                const provider = this.providerManager.getProvider(llmSession.connection.providerId);
                return provider?.models ?? [];
            }
            case LLM_IOCTL.ABORT:
                llmSession.abortController?.abort();
                llmSession.pendingStream = null;
                return;
            case LLM_IOCTL.SET_SYSTEM_PROMPT: {
                const prompt = arg as string | undefined;
                llmSession.history = llmSession.history.filter(m => m.role !== 'system');
                if (prompt)
                    llmSession.history.unshift({ role: 'system', content: prompt });
                return;
            }
            default:
                throw new Error(`LLMDeviceDriver: unknown ioctl '${String(command)}'`);
        }
    }

    private async streamChat(llmSession: LLMSessionState, params: ChatCompletionParams): Promise<AsyncGenerator<ChatCompletionChunk>> {
        llmSession.abortController?.abort();
        llmSession.pendingStream = null;
        const abort = new AbortController();
        params.signal?.addEventListener('abort', () => abort.abort(), { once: true });
        llmSession.abortController = abort;
        const lastUserMsg = params.messages.filter(m => m.role === 'user').pop();
        if (lastUserMsg) {
            this.llmLogger?.logMessage(llmSession.id, 'user', this.extractContent(lastUserMsg));
        }
        const { signal: _sig, ...logParams } = params as ChatCompletionParams & {
            signal?: unknown;
        };
        this.llmLogger?.logRequest(llmSession.id, {
            provider: llmSession.driver.providerName,
            model: llmSession.driver.currentModel ?? '',
            messages: params.messages,
            params: logParams as Record<string, unknown>,
        });
        const rawStream = await llmSession.driver.chat.create({
            ...params, stream: true, signal: abort.signal,
        });
        return this.wrapStreamOnly(rawStream, llmSession);
    }

    // ─── IConnectionService ───────────────────────────────────────────────────

    async getConnections(): Promise<ConnectionMeta[]> {
        await this.ensureReady();
        return this.connectionManager.getConnections();
    }

    async getConnection(id: string): Promise<ConnectionMeta | undefined> {
        await this.ensureReady();
        return this.connectionManager.getConnection(id);
    }

    async getDefaultConnection(operation: ModelOperation = 'chat'): Promise<ConnectionMeta | null> {
        await this.ensureReady();
        return this.connectionManager.getDefaultConnection(operation);
    }
    async setDefaultConnection(id: string | null): Promise<void> {
        return this.setModelDefault('chat', id);
    }

    async getModelDefaults(): Promise<ModelDefaults> {
        await this.ensureReady();
        return this.connectionManager.getModelDefaults();
    }
    async setModelDefault(operation: ModelOperation, id: string | null): Promise<void> {
        await this.ensureReady();
        return this.connectionManager.setModelDefault(operation, id);
    }

    async getFullConnection(id: string): Promise<LLMConnection | null> {
        await this.ensureReady();
        return this.connectionManager.getFullConnection(id);
    }

    async saveConnection(conn: LLMConnection, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        this.cancelPendingSync();
        await this.connectionManager.saveConnection(conn, systemFS);
    }

    async deleteConnection(id: string, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        this.cancelPendingSync();
        await this.connectionManager.deleteConnection(id, systemFS);
    }

    onChange(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    listConnections(): ConnectionMeta[] {
        return this.connectionManager?.listConnections() ?? [];
    }

    findConnection(id: string): ConnectionMeta | undefined {
        return this.connectionManager?.findConnection(id);
    }

    // ─── ILLMManagementService — MCP ─────────────────────────────────────────

    supportsMCPStdio(): boolean {
        return this.mcpOptions.stdioTransport !== false && (Boolean(this.mcpOptions.stdioTransport) || typeof window === 'undefined');
    }

    async getMCPServers(): Promise<MCPServer[]> {
        await this.ensureReady();
        return this.mcpManager.getMCPServers();
    }

    async saveMCPServer(server: MCPServer, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        this.cancelPendingSync();
        await this.mcpManager.saveMCPServer(server, systemFS);
    }

    async readMCPResource(id: string, uri: string) {
        await this.ensureReady(); return this.mcpManager.readMCPResource(id, uri); }
    async getMCPPrompt(id: string, name: string, args?: Record<string, string>) {
        await this.ensureReady(); return this.mcpManager.getMCPPrompt(id, name, args); }

    async testMCPServer(server: MCPServer) {
        await this.ensureReady();
        return this.mcpManager.testMCPServer(server);
    }

    async deleteMCPServer(id: string, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        this.cancelPendingSync();
        await this.mcpManager.deleteMCPServer(id, systemFS);
    }

    // ─── ILLMManagementService — Skills ──────────────────────────────────────

    async getSkills(): Promise<LLMSkill[]> {
        await this.ensureReady();
        return this.skillManager.getSkills();
    }

    async saveSkill(skill: LLMSkill, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        this.cancelPendingSync();
        await this.skillManager.saveSkill(skill, systemFS);
    }

    async deleteSkill(id: string, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        this.cancelPendingSync();
        await this.skillManager.deleteSkill(id, systemFS);
    }

    // ─── ILLMManagementService — Cost tracking ────────────────────────────────

    async recordCost(params: Parameters<import('@itookit/kernel-adapters/contracts').ILLMManagementService['recordCost']>[0]): Promise<void> {
        await this.ensureReady();
        return this.costManager.recordCost(params);
    }

    async writePricing(config: import('@itookit/kernel-adapters/contracts').ModelPricingConfig): Promise<void> {
        await this.ensureReady();
        return this.providerManager.writePricing(config);
    }

    async queryCosts(filter?: {
        dateFrom?: string;
        dateTo?: string;
        providerId?: string;
    }): Promise<import('@itookit/kernel-adapters/contracts').CostRecord[]> {
        await this.ensureReady();
        return this.costManager.queryCosts(filter);
    }

    getPricingConfig(): import('@itookit/kernel-adapters/contracts').ModelPricingConfig {
        return this.providerManager?.getPricingConfig() ?? { model_pricing: [] };
    }

    getPricingDefaults(): import('@itookit/kernel-adapters/contracts').ModelPricingConfig {
        return structuredClone(this.presets.pricing);
    }

    // ─── ILLMManagementService — Defaults metadata ────────────────────────────

    getConfigVersion(): number {
        return this.presets.version;
    }

    getDefaultAgents(): InitialAgentDef[] {
        return structuredClone(this.presets.agents);
    }

    getDefaultConnections() {
        return structuredClone(this.presets.connections);
    }

    // ─── IConnectionService — Provider metadata & testing ─────────────────────

    getProviderDefaults(): Record<string, LLMProvider> {
        return structuredClone(this.presets.providers);
    }
    getProviderReferences(): Record<string, import('../contracts/provider-reference').ProviderApiReference> {
        return structuredClone(this.presets.providerReferences ?? {});
    }

    getProvider(providerId: string): LLMProvider | undefined {
        return this.providerManager?.getProvider(providerId);
    }

    getProviders(): LLMProvider[] {
        return this.providerManager?.getProviders() ?? [];
    }

    getFullProvider(id: string): LLMProvider | undefined {
        return this.providerManager?.getFullProvider(id);
    }

    async saveProvider(provider: LLMProvider, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        const previous = this.getFullProvider(provider.id);
        if (provider.apiKey === undefined && previous?.baseURL === provider.baseURL) provider = { ...provider, apiKey: previous.apiKey };
        this.cancelPendingSync();
        await this.providerManager.saveProvider(provider, systemFS);
        await this.connectionManager.ensureProviderConnection(provider, systemFS);
    }

    async deleteProvider(id: string, systemFS?: IFileSystem): Promise<void> {
        await this.ensureReady();
        if (this.authorization.state(id).supported) await this.authorization.run('disconnect', id);
        this.cancelPendingSync();
        await this.providerManager.deleteProvider(id, systemFS);
    }

    async testConnection(params: ProviderConnectionTestParams): Promise<ConnectionTestResult> {
        await this.ensureReady();
        const provider = params.providerDefinition ?? this.getFullProvider(params.provider);
        const apiKey = params.apiKey ?? this.savedProviderKey(provider && { ...provider, baseURL: params.baseURL || provider.baseURL });
        return testLLMConnection({ ...params, apiKey, providerDefinition: provider, logger: this.logger, mediaAdapterFactory: this.mediaAdapterFactory,
            chatgpt: this.authorization.credentials(provider), codex: this.resolveCodexConfig() });
    }

    async listProviderModels(provider: LLMProvider) {
        const models = await listProviderModels({ ...provider, apiKey: provider.apiKey ?? this.savedProviderKey(provider) },
            { chatgpt: this.authorization.credentials(provider), logger: this.logger });
        const declared = this.presets.providers[provider.id];
        const trusted = declared?.baseURL === provider.baseURL && declared?.implementation === provider.implementation;
        return models.map(model => completeModelDeclaration(model, trusted ? declared.models.find(item => item.id === model.id) : undefined));
    }

    private savedProviderKey(provider: LLMProvider | undefined): string | undefined {
        const saved = provider && this.getFullProvider(provider.id);
        return saved?.baseURL === provider?.baseURL && saved?.implementation === provider?.implementation ? saved?.apiKey : undefined;
    }

    async getProviderAuthorization(id: string) { await this.ensureReady(); return this.authorization.state(id); }
    async beginProviderAuthorization(id: string) { await this.ensureReady(); return this.authorization.run('begin', id); }
    async cancelProviderAuthorization(id: string) { await this.ensureReady(); return this.authorization.run('cancel', id); }
    async disconnectProviderAuthorization(id: string) { await this.ensureReady(); return this.authorization.run('disconnect', id); }
    async completeProviderAuthorization(id: string, attempt: string, callback: string) {
        await this.ensureReady(); return this.authorization.complete(id, attempt, callback);
    }

    /** Derive the Codex CLI config shared by connection tests and driver creation. */
    private resolveCodexConfig(): CodexCLIConfig | undefined {
        return this.codexTransport
            ? { transport: this.codexTransport }
            : this.codexRunner
                ? { mode: 'exec', runner: this.codexRunner }
                : undefined;
    }

    // ─── Session management ───────────────────────────────────────────────────

    private async openConnectionSession(
        connectionId: string | undefined,
        options?: Record<string, unknown>,
    ): Promise<string> {
        const opts = options as LLMDeviceOpenOptions | undefined;
        const conn = connectionId ? this.connectionManager.findRawConnection(connectionId) : undefined;

        if (!conn) {
            throw new Error(`LLMDeviceDriver: no connection available for id '${connectionId}'`);
        }
        if (conn.enabled === false) {
            throw new Error(`LLMDeviceDriver: connection '${conn.id}' is disabled`);
        }
        const pid = conn.providerId;
        const provider = this.providerManager.getFullProviderMap().get(pid);
        if (provider?.enabled === false) {
            throw new Error(`LLMDeviceDriver: provider '${conn.providerId}' is disabled`);
        }
        const apiKey = provider?.apiKey?.trim();
        if (!apiKey && pid !== 'codex' && provider?.implementation !== 'chatgpt' && provider?.credentialMode !== 'host') {
            throw new Error(
                `LLMDeviceDriver: provider '${conn.providerId}' has no API key configured`
            );
        }

        const effectiveTiers = conn.tiers;
        const resolvedModel =
            effectiveTiers?.optimal
            ?? provider?.models[0]?.id
            ?? '';

        const resolvedModelDef = provider?.models.find(m => m.id === resolvedModel);
        const resolvedThinkingMode = resolvedModelDef?.thinkingMode;

        const connForDriver = {
            ...conn,
            apiKey,
            model: resolvedModel,
            protocol: conn.protocol,
            ...(resolvedThinkingMode ? {
                metadata: { ...conn.metadata, thinkingMode: resolvedThinkingMode },
            } : {}),
        };

        const pkey = connForDriver.providerId;
        const customProviderDefaults = provider && pkey ? { [pkey]: {
            ...provider,
            defaultProtocol: provider.defaultProtocol ?? (!provider.supportedProtocols && provider.anthropicPath
                ? 'anthropic-messages' : undefined),
        } } : undefined;

        const baseLabel = sanitizeLabel((opts?.sessionLabel as string) ?? '');
        const sessionId = baseLabel || `llm-${++this.sessionSeq}`;
        const driver = new LLMDriver({
            logger: this.logger,
            providerFactory: this.providerFactory,
            mediaAdapterFactory: this.mediaAdapterFactory,
            connection: connForDriver,
            customProviderDefaults,
            codex: this.resolveCodexConfig(),
            chatgpt: this.authorization.credentials(provider),
            hooks: {
                onResponseHeaders: (headers, status) => {
                    this.llmLogger?.logResponse(sessionId, { status, headers });
                },
            },
        });
        const history: ChatMessage[] = opts?.systemPrompt
            ? [{ role: 'system', content: opts.systemPrompt }]
            : [];

        this.sessions.set(sessionId, {
            id: sessionId,
            kind: 'llm',
            driver,
            connection: conn,
            completionDefaults: (opts?.completionDefaults ?? {}) as Record<string, unknown>,
            history,
            pendingStream: null,
            lastResponse: null,
            lastUsage: null,
            abortController: null,
        });
        return sessionId;
    }

    private async openMCPSession(
        serverId: string,
        _options?: Record<string, unknown>,
    ): Promise<string> {
        const server = this.mcpManager.getRawServers().find(s => s.id === serverId);
        if (!server) {
            throw new Error(`LLMDeviceDriver: MCP server '${serverId}' not found`);
        }

        if (!this.mcpManager.getActiveConn(serverId)) {
            await this.mcpManager.connectMCPServer(server);
        }

        const conn = this.mcpManager.getActiveConn(serverId)!;
        const sessionId = `mcp-${++this.sessionSeq}`;
        this.sessions.set(sessionId, {
            kind: 'mcp',
            connection: conn,
            server,
        });
        return sessionId;
    }

    private openSkillSession(skillId: string): string {
        const skill = this.skillManager.findSkill(skillId);
        if (!skill) throw new Error(`LLMDeviceDriver: skill '${skillId}' not found`);
        const sessionId = `skill-${++this.sessionSeq}`;
        this.sessions.set(sessionId, { kind: 'skill', skill });
        return sessionId;
    }

    // ─── VFS event binding ────────────────────────────────────────────────────

    private cancelPendingSync(): void {
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
    }

    private bindVFSEvents(): void {
        const debounce = (paths: string[]) => {
            if (!paths.some(path => path === '/' || path === '/llm' || path.startsWith('/llm/'))) return;
            if (this._syncTimer) clearTimeout(this._syncTimer);
            this._syncTimer = setTimeout(async () => {
                this._syncTimer = null;
                try {
                    await this.connectionManager.reload();
                    await this.mcpManager.reload();
                    await this.skillManager.reload();
                    this.notify();
                } catch (error) { console.error('[LLM config] refresh failed', error); }
            }, 300);
        };
        this._eventUnsubs.push(
            this.engine.on('node:created', event => debounce(event.payload.nodes.map(node => node.path))),
            this.engine.on('node:updated', event => debounce(event.payload.nodes.map(node => node.path))),
            this.engine.on('node:deleted', event => debounce(event.payload.requestedPaths)),
            this.engine.on('node:moved', event => debounce(event.payload.nodes.flatMap(node => [node.oldPath, node.newPath]))),
            this.engine.on('node:renamed', event => debounce(event.payload.nodes.flatMap(node => [node.oldPath, node.newPath]))),
        );
    }

    private notify(): void {
        this._listeners.forEach(l => { try { l(); } catch { /* suppress */ } });
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private requireLLMSession(ctx: DeviceContext): LLMSessionState {
        const s = this.sessions.get(ctx.sessionId!);
        if (!s || s.kind !== 'llm') {
            throw new Error(`LLMDeviceDriver: LLM session '${ctx.sessionId}' not found`);
        }
        return s;
    }

    private decodeMessage(content: FileContent): ChatMessage {
        const text = typeof content === 'string'
            ? content
            : new TextDecoder().decode(content instanceof Uint8Array ? content : new Uint8Array(content as ArrayBuffer));
        try {
            const parsed = JSON.parse(text);
            if (isChatMessage(parsed)) return parsed;
        } catch { /* treat as plain text */ }
        return { role: 'user', content: text };
    }

    private extractContent(msg: ChatMessage): string {
        const c = msg.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            return c
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map(p => p.text)
                .join('');
        }
        return '';
    }

    /** 有状态包装：耗尽时将 assistant 响应写入 history */
    private async *wrapAccumulate(session: LLMSessionState, gen: AsyncGenerator<ChatCompletionChunk>): AsyncGenerator<ChatCompletionChunk> {
        const parts: string[] = [];
        let usage: TokenUsage | null = null;
        try {
            for await (const chunk of gen) {
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) parts.push(delta);
                if (chunk.usage) usage = chunk.usage;
                yield chunk;
            }
        } finally {
            const response = parts.join('');
            if (response) {
                session.history.push({ role: 'assistant', content: response });
                session.lastResponse = response;
                this.llmLogger?.logMessage(session.id, 'assistant', response);
            }
            if (usage) session.lastUsage = usage;
            session.abortController = null;
        }
    }

    /** 无状态包装：不写 history（CHAT ioctl 使用），但记录日志 */
    private async *wrapStreamOnly(gen: AsyncGenerator<ChatCompletionChunk>, session: LLMSessionState): AsyncGenerator<ChatCompletionChunk> {
        const parts: string[] = [];
        try {
            for await (const chunk of gen) {
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) parts.push(delta);
                if (chunk.usage) session.lastUsage = chunk.usage;
                yield chunk;
            }
        } finally {
            const response = parts.join('');
            if (response) {
                this.llmLogger?.logMessage(session.id, 'assistant', response);
            }
            session.abortController = null;
        }
    }
}
