import { ToolProgram } from '../programs/tool-program';
import { LlmMediaEffectAdapter, type MediaResultStore } from '../effects/llm-media-effect';
import { MediaProgram } from '../programs/media-program';
import { MCPToolAdapter } from '../tool/mcp-tools';
import { silentAdapterLog, type KernelAdapterDiagnostics } from '../ports/diagnostics';
import { FSError } from '@itookit/vfs-core';
import { createSkillToolHandlers } from '../skill/tool-handlers';
import { coordinateSkillEffect, runSessionSkillOperation, invalidateSessionSkillOperations, reopenSessionSkillOperations, closeSessionSkillOperations } from '../skill/operation-queue';
import { restoreLoadedSkills } from '../skill/restore-loaded-skills';
import { createUnloadSkillHandler, unloadSkillDefinition, unloadSkillMeta } from '../tool/unload-skill';
import { SkillUnloadEffectAdapter } from '../effects/skill-unload-effect';
import { rememberLoadedSkill, withSkillDriftPersistence, requireLoadedSkillVersions } from '../skill/loaded-state';
import type { ISkillService, SkillDefinition } from '@itookit/tools/contracts';
import type { IToolService, ITTYDriver, ToolVFSContext } from '@itookit/tools/contracts';
import type { ILLMService } from '@itookit/driver-llm/contracts';
import type { IDeviceDriver } from '@itookit/vfs-core';
import { BUILTIN_TOOLS, ToolDeviceDriver } from '@itookit/tools';
import type { INativeShell, Tool } from '@itookit/tools';
import { LLMServiceAdapter } from '../llm/llm-service-adapter';
import { SkillDeviceDriver } from '../skill/skill-device-driver';
import { createLoadSkillHandler, loadSkillDefinition, loadSkillMeta } from '../tool/load-skill';
import { createShellSessionHandler, shellSessionDefinition, shellSessionMeta } from '../tty/shell-session';
import { createTtyCloseHandler, ttyCloseDefinition, ttyCloseMeta } from '../tty/tty-close';
import { createTtyWriteHandler, ttyWriteDefinition, ttyWriteMeta } from '../tty/tty-write';
import { TTYSessionManager } from '../tty/session-manager';
import { KernelAdaptersPlugin } from '../plugin/kernel-adapters-plugin';
import { LlmChatEffectAdapter, assertFrozenConnection } from '../effects/llm-chat-effect';
import { ToolCallEffectAdapter } from '../effects/tool-call-effect';
import { BashEffectAdapter } from '../effects/bash-effect';
import { SkillLoadEffectAdapter } from '../effects/skill-load-effect';
import { TtyEffectAdapter } from '../effects/tty-effect';
import type {
    SessionCapabilityRegistry,
    SessionCapabilityScope,
    SkillSource,
    SkillToolHandlerFactory,
} from '../ports/capabilities';
import { ApprovedEffectProgram } from '../programs/approved-effect-program';
import { ExecProgram } from '../programs/exec-program';
import { ContextPrepareEffect, ContextLlmEffect, ContextToolEffect, type ContextServiceResolver } from '../context/effects';

export interface KernelAdaptersRuntimeOptions extends KernelAdapterDiagnostics {
    taskAssetStore?: import('@itookit/tools/contracts').TaskAssetStore;
    readTaskAsset?: import('@itookit/tools/contracts').TaskAssetReader;
    mediaResultStore?: MediaResultStore;
    contextService?: ContextServiceResolver;
    effectTools?: import('../effects/tool-call-effect').EffectToolBinding[];
    /** Resolve a trusted Task to its isolated Run identity; undefined selects the normal Session. */
    scopeForEffect?: (context: import('@itookit/durable-kernel').EffectExecutionContext) => Promise<string | undefined>;
    fileContextForScope?: (sessionId: string, scopeId: string) => ReturnType<NonNullable<KernelAdaptersRuntimeOptions['fileContextForSession']>>;
    /** Acquired independently for each real Session, before any tool can run. */
    fileContextForSession?: (sessionId: string) => Promise<{
        vfs: ToolVFSContext;
        cwd: string;
        release(): Promise<void>;
        nativeShell?: INativeShell;
        ttyDriver?: ITTYDriver;
    }>;
    llmDriver: IDeviceDriver;
    configureSession?: (sessionId: string, scope: SessionCapabilityScope & { toolDriver: ToolDeviceDriver }) => Promise<void> | void;
    runMode?: 'kernel';
    skillSource?: SkillSource;
    /** Create a source using only the acquired Session file view. */
    skillSourceForSession?: (files: { vfs: ToolVFSContext; cwd: string }) => SkillSource;
    skillToolHandlerFactory?: SkillToolHandlerFactory;
    /** Additional application tools registered in every isolated session scope. */
    additionalTools?: Tool[];
}

export interface KernelAdaptersRuntime {
    llmService: ILLMService;
    toolCatalog: Pick<IToolService, 'getToolDefinitions' | 'getToolMeta' | 'listTools'>;
    skillCatalog: Pick<ISkillService, 'getSkillNames' | 'saveSkill' | 'deleteSkill'>;
    sessions: SessionCapabilityRegistry;
    plugin: KernelAdaptersPlugin;
    disposeSession(sessionId: string): Promise<void>;
    disposeScope(sessionId: string, scopeId: string): Promise<void>;
    dispose(): Promise<void>;
}

export async function createKernelAdaptersRuntime(options: KernelAdaptersRuntimeOptions): Promise<KernelAdaptersRuntime> {
    const llmService = new LLMServiceAdapter(options.llmDriver, options.runMode ?? 'kernel');
    const definitions = new Map<string, SkillDefinition>();
    const registry = new KernelAdaptersSessionRegistry(options, definitions);
    // Metadata only: no executable tool/skill service escapes through the catalog.
    const catalogSkills = new SkillDeviceDriver({ registry: definitions });
    const catalogTools = new ToolDeviceDriver([...BUILTIN_TOOLS, ...(options.additionalTools ?? [])]);
    registerCoreTools(catalogTools, catalogSkills);
    registerEffectTools(catalogTools, options.effectTools);
    await catalogTools.init();
    const effects = createEffects(llmService, registry, Boolean(options.fileContextForSession || options.fileContextForScope), options.effectTools, options);
    if (options.mediaResultStore) {
        const authorize = options.authorizeMedia ?? (options.authorizeLlm ? async () => { throw new Error('Media runtime requires the host model authorization gate'); } : undefined);
        effects.push(new LlmMediaEffectAdapter(llmService, options.mediaResultStore, authorize));
    }
    if (options.contextService) effects.push(new ContextPrepareEffect(options.contextService, request => assertFrozenConnection(llmService, {
        resourceHandleId: request.resourceHandleId, connectionId: request.connectionId, connectionSnapshot: request.connectionSnapshot,
        request: request.request as unknown as import('../effects/llm-chat-effect').LlmChatEffectRequest['request'],
    })),
        new ContextLlmEffect(options.contextService, effects.find(effect => effect.kind === 'llm.chat')! as LlmChatEffectAdapter),
        new ContextToolEffect(options.contextService, effects.find(effect => effect.kind === 'tool.call')! as ToolCallEffectAdapter));
    return {
        llmService,
        toolCatalog: {
            listTools: () => catalogTools.listTools(),
            getToolDefinitions: () => catalogTools.getToolDefinitions(),
            getToolMeta: id => catalogTools.getToolMeta(id),
        },
        skillCatalog: {
            getSkillNames: () => catalogSkills.getSkillNames(),
            saveSkill: skill => catalogSkills.saveSkill(skill),
            deleteSkill: id => registry.deleteSkill(id, catalogSkills),
        },
        sessions: registry,
        plugin: new KernelAdaptersPlugin({
            effects: effects.map(effect => coordinateSkillEffect(effect, registry)),
            programs: [new ApprovedEffectProgram(), new ExecProgram(), new MediaProgram(), new ToolProgram()],
            onSessionClosed: sessionId => registry.disposeSession(sessionId),
        }),
        disposeSession: sessionId => registry.disposeSession(sessionId),
        disposeScope: (sessionId, scopeId) => registry.disposeScope(sessionId, scopeId),
        dispose: async () => { await registry.dispose(); await catalogTools.dispose(); await catalogSkills.dispose(); },
    };
}

interface KernelAdaptersScope extends SessionCapabilityScope {
    processContext: { cwd?: string; shellAttached: boolean };
    toolDriver: ToolDeviceDriver;
    skillDriver: SkillDeviceDriver;
    ttySessions?: TTYSessionManager;
}

class KernelAdaptersSessionRegistry implements SessionCapabilityRegistry {
    private readonly runScopes = new Map<string, Map<string, KernelAdaptersSessionRegistry>>();
    private readonly effectScopes = new WeakMap<import('@itookit/durable-kernel').EffectExecutionContext, Promise<string | undefined>>();
    private disposal?: Promise<void>;
    private closeWork?: () => Promise<void>;
    private closed = false;
    private readonly closing = new Map<string, Promise<void>>();
    private readonly sessionClosers = new Map<string, () => Promise<void>>();
    private readonly scopes = new Map<string, Promise<KernelAdaptersScope>>();
    private readonly hydrated = new Set<string>();
    private readonly hydrating = new Map<string, Promise<KernelAdaptersScope>>();

    constructor(private readonly options: KernelAdaptersRuntimeOptions,
        private readonly skillDefinitions: Map<string, SkillDefinition>) {}

    get(sessionId: string): Promise<KernelAdaptersScope> {
        if (this.closed) return Promise.reject(new Error('Session capability registry is closed'));
        if (this.sessionClosers.has(sessionId)) return Promise.reject(new Error('Session capability scope is closing'));
        const current = this.scopes.get(sessionId);
        if (current) return current;
        const created = this.createScope(sessionId);
        this.scopes.set(sessionId, created);
        void created.catch(() => { if (this.scopes.get(sessionId) === created) this.scopes.delete(sessionId); });
        return created;
    }

    async deleteSkill(id: string, catalog: SkillDeviceDriver): Promise<void> {
        if (this.closed) throw new Error('Session capability registry is closed');
        for (const pending of this.scopes.values()) await (await pending).skillService.deleteSkill(id);
        for (const scopes of this.runScopes.values()) for (const scope of scopes.values()) {
            for (const pending of scope.scopes.values()) await (await pending).skillService.deleteSkill(id);
        }
        await catalog.deleteSkill(id);
    }

    async getForContext(
        context: import('@itookit/durable-kernel').EffectExecutionContext,
    ): Promise<KernelAdaptersScope> {
        const registry = await this.forEffect(context);
        if (registry !== this) return registry.getForContext(context);
        const saved = await context.sessionState?.get('kernel-adapters.skills.loaded');
        requireLoadedSkillVersions(saved?.value);
        const scope = await this.get(context.sessionId);
        return withSkillDriftPersistence(scope.skillService, context.sessionState, async () => {
            await this.restore(context.sessionId, saved?.value);
            await scope.skillDriver.validateLoadedVersions();
            return scope;
        });
    }

    async getForEffect(context: import('@itookit/durable-kernel').EffectExecutionContext): Promise<KernelAdaptersScope> {
        return (await this.forEffect(context)).get(context.sessionId);
    }

    private async forEffect(context: import('@itookit/durable-kernel').EffectExecutionContext): Promise<KernelAdaptersSessionRegistry> {
        let selected = this.effectScopes.get(context);
        if (!selected) {
            selected = Promise.resolve().then(() => this.options.scopeForEffect?.(context));
            this.effectScopes.set(context, selected);
        }
        const scopeId = await selected;
        if (this.closed || this.sessionClosers.has(context.sessionId)) throw new Error('Session capability scope is closing');
        if (scopeId === undefined) return this;
        if (!scopeId.trim() || !this.options.fileContextForScope) throw new Error('Isolated scope requires an identity and file context factory');
        const scopes = this.runScopes.get(context.sessionId) ?? new Map<string, KernelAdaptersSessionRegistry>();
        this.runScopes.set(context.sessionId, scopes);
        let scope = scopes.get(scopeId);
        if (!scope) {
            scope = new KernelAdaptersSessionRegistry({ ...this.options, scopeForEffect: undefined,
                fileContextForScope: undefined,
                fileContextForSession: id => this.options.fileContextForScope!(id, scopeId) }, this.skillDefinitions);
            scopes.set(scopeId, scope);
        }
        return scope;
    }

    /** Keep the closed registry as a tombstone so late Effects cannot recreate this Run scope. */
    async disposeScope(sessionId: string, scopeId: string): Promise<void> {
        const scopes = this.runScopes.get(sessionId) ?? new Map<string, KernelAdaptersSessionRegistry>();
        this.runScopes.set(sessionId, scopes);
        let scope = scopes.get(scopeId);
        if (!scope) { scope = new KernelAdaptersSessionRegistry(this.options, this.skillDefinitions); scopes.set(scopeId, scope); }
        await scope.dispose();
    }

    restore(sessionId: string, loadedSkillIds: unknown): Promise<KernelAdaptersScope> {
        const pending = this.hydrating.get(sessionId);
        if (pending) return pending;
        const restored = this.restoreScope(sessionId, loadedSkillIds);
        this.hydrating.set(sessionId, restored);
        void restored.finally(() => {
            if (this.hydrating.get(sessionId) === restored) this.hydrating.delete(sessionId);
        }).catch(() => undefined);
        return restored;
    }

    private async restoreScope(sessionId: string, value: unknown): Promise<KernelAdaptersScope> {
        const opening = this.get(sessionId);
        const identity = this.scopes.get(sessionId);
        const scope = await opening;
        if (this.closed || this.scopes.get(sessionId) !== identity) throw new Error('Session scope changed during Skill restoration');
        if (this.hydrated.has(sessionId)) return scope;
        await restoreLoadedSkills(scope.skillService, value);
        if (this.closed || this.scopes.get(sessionId) !== identity) throw new Error('Session scope changed during Skill restoration');
        this.hydrated.add(sessionId);
        return scope;
    }

    async disposeSession(sessionId: string): Promise<void> {
        const pending = this.closing.get(sessionId);
        if (pending) return pending;
        let cleanup = this.sessionClosers.get(sessionId);
        if (!cleanup) {
            const drained = invalidateSessionSkillOperations(this, sessionId);
            const scope = this.scopes.get(sessionId);
            const hydration = this.hydrating.get(sessionId);
            this.scopes.delete(sessionId);
            this.hydrated.delete(sessionId);
            this.hydrating.delete(sessionId);
            const runs = [...(this.runScopes.get(sessionId)?.values() ?? [])];
            this.runScopes.delete(sessionId);
            cleanup = retryCleanup([
                () => drained,
                () => hydration?.catch(() => undefined),
                ...runs.map(run => () => run.dispose()),
                () => scope?.then(value => value.dispose(), () => {}),
            ]);
            this.sessionClosers.set(sessionId, cleanup);
        }
        const close = cleanup();
        this.closing.set(sessionId, close);
        try {
            await close;
            this.sessionClosers.delete(sessionId);
            reopenSessionSkillOperations(this, sessionId);
        } finally { this.closing.delete(sessionId); }
    }

    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        const pending = this.close();
        this.disposal = pending;
        void pending.catch(() => { if (this.disposal === pending) this.disposal = undefined; });
        return pending;
    }

    private close(): Promise<void> {
        if (this.closeWork) return this.closeWork();
        this.closed = true;
        const drained = closeSessionSkillOperations(this);
        const scopes = [...this.scopes.values()];
        const hydration = [...this.hydrating.values()];
        const runs = [...this.runScopes.values()].flatMap(scopes => [...scopes.values()]);
        this.runScopes.clear();
        this.scopes.clear();
        this.hydrated.clear();
        this.hydrating.clear();
        this.closeWork = retryCleanup([
            () => drained,
            () => Promise.allSettled(hydration),
            ...this.sessionClosers.values(),
            ...runs.map(run => () => run.dispose()),
            ...scopes.map(scope => async () => { await (await scope.catch(() => undefined))?.dispose(); }),
        ]);
        return this.closeWork();
    }

    private async createScope(sessionId: string): Promise<KernelAdaptersScope> {
        const files = this.options.fileContextForSession
            ? await this.options.fileContextForSession(sessionId) : undefined;
        const toolDriver = new ToolDeviceDriver([
            ...BUILTIN_TOOLS,
            ...(this.options.additionalTools ?? []),
        ]);
        if (this.options.taskAssetStore) toolDriver.setAssetStore(this.options.taskAssetStore);
        if (this.options.readTaskAsset) toolDriver.setAssetReader(this.options.readTaskAsset);
        if (files) toolDriver.setFileContext(files.vfs, files.cwd);
        else toolDriver.setFileContext({
            readFile: async () => { throw new Error('Session has no file capability'); },
            writeFile: async () => { throw new Error('Session has no file capability'); },
            listFiles: async () => { throw new Error('Session has no file capability'); },
        }, '/');
        const nativeShell = files?.nativeShell;
        if (nativeShell) toolDriver.setNativeShell(nativeShell);
        let source: SkillSource | undefined;
        try { source = files && this.options.skillSourceForSession
            ? this.options.skillSourceForSession(files) : this.options.skillSource; }
        catch (error) { return cleanupAfterFailure(error, [() => files?.release(), () => toolDriver.dispose()]); }
        const mcp = new MCPToolAdapter(this.options.llmDriver);
        const defaults = createSkillToolHandlers(mcp, nativeShell);
        const skillDriver = new SkillDeviceDriver({
            registry: this.skillDefinitions,
            source,
            readFile: files ? path => files.vfs.readFile(path) : undefined,
            toolHandlerFactory: { create: (skill, binding) =>
                this.options.skillToolHandlerFactory?.create(skill, binding) ?? defaults.create(skill, binding) },
        });
        skillDriver.setToolService(toolDriver.getService());
        const ttySessions = registerCoreTools(toolDriver, skillDriver.getService(), files?.ttyDriver);
        registerEffectTools(toolDriver, this.options.effectTools);
        try {
            await toolDriver.init();
            if (files && this.options.skillSourceForSession) await skillDriver.getService().setCwd(files.cwd);
        }
        catch (error) { return cleanupAfterFailure(error, [() => files?.release(), () => toolDriver.dispose(), () => skillDriver.dispose()]); }
        const scope = createScope(toolDriver, skillDriver, { cwd: files?.cwd, shellAttached: !!nativeShell }, ttySessions);
        scope.resolveMCPToolIds = profiles => mcp.resolveProfiles(profiles);
        scope.prepareTools = ids => mcp.prepare(scope.toolService, ids);
        const dispose = scope.dispose.bind(scope);
        scope.dispose = retryCleanup([() => dispose(), () => files?.release()]);
        try { await this.options.configureSession?.(sessionId, scope); }
        catch (error) { return cleanupAfterFailure(error, [() => scope.dispose()]); }
        return scope;
    }
}

/** Run every cleanup step even if one fails; report failures together. */
async function runCleanup(steps: Array<() => Promise<unknown> | undefined>): Promise<void> {
    const errors: unknown[] = [];
    for (const step of steps) {
        try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Session scope cleanup failed');
}

/**
 * Preserve the original initialization error while still attempting every cleanup
 * step: a failing release must not skip driver disposal or hide the cause.
 */
async function cleanupAfterFailure(cause: unknown, steps: Array<() => Promise<unknown> | undefined>): Promise<never> {
    try { await runCleanup(steps); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Session scope initialization failed and cleanup reported errors'); }
    throw cause;
}

function createScope(
    toolDriver: ToolDeviceDriver,
    skillDriver: SkillDeviceDriver,
    processContext: KernelAdaptersScope['processContext'],
    ttySessions?: TTYSessionManager,
): KernelAdaptersScope {
    return {
        processContext,
        toolDriver,
        skillDriver,
        ttySessions,
        toolService: toolDriver.getService(),
        skillService: skillDriver.getService(),
        async dispose() {
            ttySessions?.abortAll();
            await Promise.all([toolDriver.dispose(), skillDriver.dispose()]);
        },
    };
}

function createEffects(
    llm: ILLMService,
    registry: KernelAdaptersSessionRegistry,
    ttyEnabled: boolean,
    effectTools: import('../effects/tool-call-effect').EffectToolBinding[] = [],
    diagnostics: KernelAdaptersRuntimeOptions,
): import('@itookit/durable-kernel').EffectAdapter[] {
    const tools = async (context: import('@itookit/durable-kernel').EffectExecutionContext) =>
        (await registry.getForContext(context)).toolService;
    const skills = async (context: import('@itookit/durable-kernel').EffectExecutionContext) =>
        (await registry.getForContext(context)).skillService;
    const effects: import('@itookit/durable-kernel').EffectAdapter[] = [
        new LlmChatEffectAdapter(llm, diagnostics.logger, diagnostics.authorizeLlm, diagnostics.readTaskAsset),
        new ToolCallEffectAdapter(async (context, request) => {
            const scope = await registry.getForEffect(context);
            const meta = scope.toolService.getToolMeta(request.toolId);
            if (meta?.skillUnloaderArgKey) return scope.toolService;
            if (meta?.skillLoaderArgKey) return tools(context);
            return runSessionSkillOperation(registry, context.sessionId, async () => {
                const ready = await registry.getForContext(context);
                await ready.prepareTools?.([request.toolId]);
                return ready.toolService;
            });
        }, async (skillId, context) => {
            const service = await skills(context);
            const skill = service.getLoadedSkills().find(item => item.id === skillId);
            if (!skill || skill.disableModelInvocation) return;
            const toolService = await tools(context);
            const definitions = toolService.getToolDefinitions();
            const boundTools = skill.tools.flatMap(binding => {
                const meta = toolService.getToolMeta(binding.toolId);
                const name = binding.definition.function?.name ?? binding.definition.name ?? binding.toolId;
                const definition = definitions.find(item => (item.function?.name ?? item.name) === name);
                return meta?.enabled && definition
                    ? [{ toolId: binding.toolId, definition: structuredClone(definition), external: meta.sideEffect === 'external' }]
                    : [];
            });
            const snapshot = { skillId, compactInstructions: skill.compact?.rawContent ?? '', tools: boundTools };
            await persistLoadedSkill({ skillId, success: true, toolIds: [], snapshot: service.getSkillSnapshot?.(skillId) }, context);
            return snapshot;
        }, context => skills(context), effectTools, diagnostics.logger),
        new BashEffectAdapter(context => runSessionSkillOperation(registry, context.sessionId, async () => {
            const scope = await registry.getForContext(context);
            if (!scope.processContext.shellAttached) {
                (diagnostics.logger ?? silentAdapterLog).error('[process.context] No execution backend', { sessionId: context.sessionId,
                    taskId: context.taskId, ...scope.processContext });
                throw new FSError('ECAPABILITY', diagnostics.processUnavailableMessage?.() ?? 'Process execution is unavailable', 'process.exec', scope.processContext.cwd);
            }
            return scope.toolService;
        }), diagnostics.logger),
        new SkillLoadEffectAdapter(skills, persistLoadedSkill),
        new SkillUnloadEffectAdapter(async context => (await registry.getForEffect(context)).skillService),
    ];
    if (ttyEnabled) effects.push(new TtyEffectAdapter(context => runSessionSkillOperation(registry, context.sessionId, () => tools(context))));
    return effects;
}

async function persistLoadedSkill(
    result: import('@itookit/tools/contracts').SkillLoadResult,
    context: import('@itookit/durable-kernel').EffectExecutionContext,
): Promise<void> {
    await rememberLoadedSkill(result.skillId, context.sessionState, result.snapshot);
}

function registerEffectTools(driver: ToolDeviceDriver, bindings: KernelAdaptersRuntimeOptions['effectTools'] = []): void {
    const service = driver.getService();
    for (const binding of bindings) {
        if (service.getToolMeta(binding.meta.id)) throw new Error(`Duplicate Effect tool: ${binding.meta.id}`);
        service.registerTool(binding.meta, binding.definition, async () => { throw new Error('Tool requires Kernel Effect identity'); });
    }
}


function registerCoreTools(
    tools: ToolDeviceDriver,
    skills: ISkillService,
    tty?: ITTYDriver,
): TTYSessionManager | undefined {
    tools.registerTool(loadSkillMeta, loadSkillDefinition, createLoadSkillHandler(skills));
    tools.registerTool(unloadSkillMeta, unloadSkillDefinition, createUnloadSkillHandler(skills));
    if (!tty) return undefined;
    const sessions = new TTYSessionManager();
    tools.registerTool(shellSessionMeta, shellSessionDefinition, createShellSessionHandler(tty, sessions));
    tools.registerTool(ttyWriteMeta, ttyWriteDefinition, createTtyWriteHandler(sessions));
    tools.registerTool(ttyCloseMeta, ttyCloseDefinition, createTtyCloseHandler(sessions));
    return sessions;
}

/** Retain only failed cleanup steps; concurrent callers share the same attempt. */
function retryCleanup(steps: Array<() => Promise<unknown> | undefined>): () => Promise<void> {
    const remaining = new Set(steps);
    let pending: Promise<void> | undefined;
    return () => {
        if (pending) return pending;
        const run = async () => {
            const errors: unknown[] = [];
            for (const step of remaining) {
                try { await step(); remaining.delete(step); } catch (error) { errors.push(error); }
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length) throw new AggregateError(errors, 'Session scope cleanup failed');
        };
        const attempt = run();
        pending = attempt;
        void attempt.catch(() => { if (pending === attempt) pending = undefined; });
        return attempt;
    };
}
