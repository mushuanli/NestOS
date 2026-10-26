import { t, createModuleLogger } from '@itookit/common';
import { Kernel, type RecoveryOptions, type SessionStorageResolver } from '@itookit/durable-kernel';
import {
    createKernelAdaptersRuntime,
    createMediaResultStore,
    type KernelAdaptersRuntime,
    type KernelAdaptersRuntimeOptions,
} from '@itookit/kernel-adapters';
import {
    createBuiltinDagPluginRegistry,
    DagPluginRegistry,
    registerDurablePrograms,
    resolveFlowTaskWorkspace,
} from '@itookit/llm-flow';
import type { IFileSystem } from '@itookit/vfs-core';
import { createMemoryTools } from './memory-tools';
import {createTaskAssetStore} from './task-asset-store';
import { createTaskAssetReader } from './task-assets';
import { SessionMemoryProvider, SharedMemoryStore } from '@itookit/llm-session';
import { createRuntimeContextResolver } from './context-service';
import { createRuntimeContextGc, type RuntimeContextGc, type RuntimeContextGcOptions } from './context-gc';

export interface CreateKernelRuntimeOptions {
    /** Host Session ownership and policy checks; Kernel still enforces exact plan capabilities. */
    authorizeTaskCall?: import('@itookit/durable-kernel').TaskCallAuthority;
    harnessExecution?: KernelAdaptersRuntimeOptions['harnessExecution'];
    authorizeLlm?: KernelAdaptersRuntimeOptions['authorizeLlm'];
    authorizeMedia?: KernelAdaptersRuntimeOptions['authorizeMedia'];
    contextEngineOptions?: import('@itookit/llm-context').ContextEngineOptions;
    contextGc?: RuntimeContextGcOptions | false;
    /** Override the context storage/engine ports at the host composition boundary. */
    contextService?: import('@itookit/kernel-adapters').ContextServiceResolver;
    /** System VFS view used for the Kernel catalog and storage binding. */
    systemFS: IFileSystem;
    llmDriver: KernelAdaptersRuntimeOptions['llmDriver'];
    storageResolver: SessionStorageResolver;
    maxConcurrent?: number;
    maxConcurrentEffects?: number;
    fileContextForSession?: KernelAdaptersRuntimeOptions['fileContextForSession'];
    scopeForEffect?: KernelAdaptersRuntimeOptions['scopeForEffect'];
    fileContextForScope?: KernelAdaptersRuntimeOptions['fileContextForScope'];
    configureSession?: KernelAdaptersRuntimeOptions['configureSession'];
    skillSource?: KernelAdaptersRuntimeOptions['skillSource'];
    skillSourceForSession?: KernelAdaptersRuntimeOptions['skillSourceForSession'];
    skillToolHandlerFactory?: KernelAdaptersRuntimeOptions['skillToolHandlerFactory'];
    additionalTools?: KernelAdaptersRuntimeOptions['additionalTools'];
    dagPlugins?: DagPluginRegistry;
    /** Register the shared Durable programs before initialize. Defaults to true. */
    registerPrograms?: boolean;
    /** Recover persisted Sessions after initialize. Defaults to `{}`. Pass false to skip. */
    recover?: RecoveryOptions | boolean;
    /** Runs after initialize/registerPrograms and before recover. */
    beforeRecover?: (runtime: HeadlessKernelRuntime) => void | Promise<void>;
}

export interface HeadlessKernelRuntime extends KernelAdaptersRuntime {
    contextGc?: RuntimeContextGc;
    kernel: Kernel;
    dagPlugins: DagPluginRegistry;
    memory: SessionMemoryProvider;
}

/**
 * Shared headless Kernel composition used by app-shell (Web/Tauri) and CLI.
 * Hosts inject platform file/process/skill capabilities; this function owns the
 * durable-kernel + kernel-adapters wiring and Durable program registration.
 */
export async function createKernelRuntime(
    options: CreateKernelRuntimeOptions,
): Promise<HeadlessKernelRuntime> {
    const dagPlugins = options.dagPlugins ?? createBuiltinDagPluginRegistry();
    const sharedMemory = new SharedMemoryStore(options.systemFS);
    await sharedMemory.init();
    const contextGc = options.contextService || options.contextGc === false ? undefined
        : createRuntimeContextGc(() => kernel, options.contextGc);
    const adapters = await createKernelAdaptersRuntime({
        harnessExecution: options.harnessExecution,
        contextService: options.contextService ?? createRuntimeContextResolver(() => kernel, () => adapters.llmService, contextGc?.observe, options.contextEngineOptions),
        logger: createModuleLogger('kernel-adapters'),
        processUnavailableMessage: () => t('chatInput.command.unavailable'),
        llmDriver: options.llmDriver,
        authorizeLlm: options.authorizeLlm,
        authorizeMedia: options.authorizeMedia,
        mediaResultStore: createMediaResultStore(async context => {
            const { storage } = await kernel.inspectSession(context.sessionId);
            return kernel.storageResolvers.resolve(storage.kind).resolve(storage);
        }),
        runMode: 'kernel',
        fileContextForSession: options.fileContextForSession,
        scopeForEffect: options.scopeForEffect ?? (options.fileContextForScope ? async context => {
            const session = await kernel.openSession(context.sessionId);
            return (await resolveFlowTaskWorkspace(session, context.taskId))?.rootTaskId;
        } : undefined),
        fileContextForScope: options.fileContextForScope,
        configureSession: options.configureSession,
        skillSource: options.skillSource,
        skillSourceForSession: options.skillSourceForSession,
        skillToolHandlerFactory: options.skillToolHandlerFactory,
        additionalTools: options.additionalTools,
        readTaskAsset: createTaskAssetReader(() => kernel, options.systemFS),
        taskAssetStore: createTaskAssetStore(() => kernel),
        effectTools: createMemoryTools(() => kernel, () => memory),
    });

    const kernel = new Kernel({
        catalog: { fs: options.systemFS, rootPath: '/var/lib/kernel' },
        maxConcurrent: options.maxConcurrent,
        maxConcurrentEffects: options.maxConcurrentEffects,
        authorizeTaskCall: options.authorizeTaskCall,
    });
    const memory = new SessionMemoryProvider(kernel, sharedMemory);
    kernel.registerStorageResolver(options.storageResolver);
    if (contextGc) {
        const closeAdapterSession = adapters.plugin.onSessionClosed.bind(adapters.plugin);
        adapters.plugin.onSessionClosed = async id => {
            await contextGc.forget(id);
            await closeAdapterSession(id);
        };
    }
    await kernel.use(adapters.plugin);
    if (options.registerPrograms !== false) registerDurablePrograms(kernel, undefined, true);
    await kernel.initialize();

    const disposeAdapters = adapters.dispose.bind(adapters);
    const disposeSession = adapters.disposeSession.bind(adapters);
    const runtime = Object.assign(adapters, { kernel, dagPlugins, memory, contextGc,
        async dispose() { await contextGc?.dispose(); await disposeAdapters(); },
        async disposeSession(id: string) { await contextGc?.forget(id); await disposeSession(id); },
    }) as HeadlessKernelRuntime;
    try {
        await options.beforeRecover?.(runtime);
        if (options.recover !== false) {
            await kernel.recover(options.recover === true || options.recover === undefined ? {} : options.recover);
            if (contextGc) for await (const session of kernel.listSessions()) await contextGc.observeSession(session.id, session.storage);
        }
        return runtime;
    } catch (error) {
        kernel.dispose();
        const failures: unknown[] = [error];
        for (const close of [() => kernel.waitIdle(), () => runtime.dispose()]) {
            try { await close(); } catch (failure) { failures.push(failure); }
        }
        if (failures.length > 1) throw new AggregateError(failures, 'Kernel initialization cleanup failed');
        throw error;
    }
}
