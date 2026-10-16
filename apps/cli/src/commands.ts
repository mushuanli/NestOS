import { recordRuntimeDiagnostic } from './diagnostics';
import { acquireRunSchedulerLock } from './run-scheduler-lock';
import { markRunDeleted } from './run-scheduler-lease';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stringify as yamlStringify } from 'yaml';
import type { EventEnvelope, ExitRecord, JsonValue, Kernel, TaskHandle } from '@itookit/durable-kernel';
import { loadWorkflow, parseDuration, validateWorkflow } from './config';
import { expandWorkflow } from './expand';
import { resolveProfileRoot } from './mindos';
import { compileDag, createCliRuntime, cliStorage, type CliRuntime } from './runtime';
import { compileRunDefinition } from './run-definition';
import { createRunDefinitionFromFlow, toDagRunSpec, type RunDefinition } from '@itookit/app-core';
import { loadFlowDefinition } from './flow-config';
import { readFlowTaskTranscript } from '@itookit/llm-flow';
import { RunStore, selectFinalResult } from './run-store';
import { sandboxDoctor } from './shell';
import type { BlockedEffect, CompiledWorkflow, PendingInteraction, RunManifest } from './types';

export interface CommandOptions {
    connect?: string;
    clientCert?: string;
    clientKey?: string;
    caCert?: string;
    authDir?: string;
    certDir?: string;
    staticDir?: string;
    auditFile?: string;
    agent?: string;
    branch?: string;
    file?: string;
    paramsFile?: string;
    stateDir?: string;
    headless?: boolean;
    json?: boolean;
    sandbox?: 'native' | 'oci';
    /** Profile selector: desktop (default) or an explicit data root path. */
    profile?: string;
    /** Map a host directory to /workspace and use it as the Session cwd. */
    setHome?: string;
    /** Map additional host directories into the Session runtime context. */
    addDir?: string[];
    grantMemory?: string[];
    follow?: boolean;
    approve?: boolean;
    deny?: boolean;
    value?: string;
    offline?: boolean;
    /** -p / --prompt：直接运行一段 prompt（生成临时配置并执行）。 */
    prompt?: string;
    model?: string;
    apiKeyEnv?: string;
    /** --credential-env: environment variable holding the remote file server credential. */
    credentialEnv?: string;
    baseUrl?: string;
    /** --no-tools: omit client tools from a quick prompt. */
    noTools?: boolean;
    /** --protocol：API 协议（openai-chat / openai-responses 等）。 */
    protocol?: string;
    /** --responses-path：OpenAI Responses API 端点路径（如 /responses）。 */
    responsesPath?: string;
    /** --verbose：输出全部事件（默认过滤高频 stream 增量与 task 生命周期）。 */
    verbose?: boolean;
    /** export 的输出文件路径；默认 <stateDir>/exports/<runId>.json。 */
    out?: string;
    /** export 的 transcript 字节预算，默认 256 KiB。 */
    maxBytes?: number;
    /** --retry-indeterminate：resume 时对无法核对结果的 Effect 授权重放。 */
    retryIndeterminate?: boolean;
    /** -d / --http: start the browser-accessible MindOS UI on [ip:]port. */
    http?: string;
}

interface InterruptWatcher {
    signal?: NodeJS.Signals;
    dispose(): void;
}

const STALL_WARN_MS = 60_000;

/** How long a cancelled Run waits for its node Tasks to settle before projecting statuses. */
const PROJECTION_SETTLE_MS = 2_000;

const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled', 'skipped'];

function isTerminalTaskStatus(status: string): boolean {
    return TERMINAL_TASK_STATUSES.includes(status);
}

export async function validateCommand(options: CommandOptions): Promise<number> {
    // --offline skips the environment check so configs can be validated without API keys set.
    const loaded = await loadWorkflow(options.file ?? 'mindos.yml', !options.offline);
    print(options, { valid: true, name: loaded.workflow.config.name, tasks: loaded.workflow.config.tasks.length });
    return 0;
}

/** 打印编译后的 DAG 结构（节点 + 边），不执行 —— 等价于 run --dry-run 的诉求。 */
export async function graphCommand(options: CommandOptions): Promise<number> {
    const loaded = await loadWorkflow(options.file ?? 'mindos.yml', !options.offline);
    const dag = compileDag(loaded.workflow);
    print(options, {
        name: loaded.workflow.config.name,
        nodes: dag.nodes.map(node => ({ id: node.id, plugin: node.plugin, name: node.name })),
        edges: dag.edges.map(edge => ({
            from: edge.from, to: edge.to, output: edge.output, input: edge.input,
            ...(edge.onFailure ? { onFailure: edge.onFailure } : {}),
        })),
    });
    return 0;
}

export async function runCommand(options: CommandOptions): Promise<number> {
    const file = options.file ?? 'mindos.yml';
    if (file.toLowerCase().endsWith('.flow')) return runFlowCommand(file, options);
    if (options.paramsFile) throw new Error('--params is only supported for .flow inputs');
    const loaded = await loadWorkflow(file);
    return runLoaded(loaded, options);
}

async function runFlowCommand(file: string, options: CommandOptions): Promise<number> {
    const flow = await loadFlowDefinition(file);
    const parameters = options.paramsFile ? await loadRunParameters(options.paramsFile) : undefined;
    const workspaceRoot = path.resolve(options.setHome ?? process.cwd());
    const resultTask = String(flow.nodes.at(-1)?.id ?? '');
    if (!resultTask) throw new Error('.flow has no nodes to use as the result task');
    const definition = await createRunDefinitionFromFlow(flow, {
        workspaceRoot,
        result: { task: resultTask, output: 'result' },
    });
    const stateDir = resolveStateDir(options, workspaceRoot);
    const workflow: CompiledWorkflow = {
        config: {
            version: 1,
            name: flow.name,
            goal: flow.name,
            providers: [],
            connections: [],
            agents: [],
            tasks: [],
            result: { task: resultTask, output: 'result' },
            sandbox: { mode: 'native' },
        },
        workspaceRoot,
        stateDir,
    };
    const loaded = { workflow, source: JSON.stringify(flow), hash: definition.digest };
    return runLoaded(loaded, options, { definition, parameters, useProfileConfig: true });
}

async function loadRunParameters(file: string): Promise<Record<string, JsonValue>> {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('--params must contain a JSON object');
    }
    return value as Record<string, JsonValue>;
}

/**
 * Run a quick prompt with file search and optional client WebSearch tools.
 * Defaults to deepseek-v4-flash and DEEPSEEK_LLM_TOKEN.
 * Responses uses server-side web search instead of the client WebSearch tool.
 */
export async function promptCommand(options: CommandOptions): Promise<number> {
    const prompt = (options.prompt ?? '').trim();
    if (!prompt) throw new Error('prompt required (use -p "your prompt")');
    const model = options.model ?? 'deepseek/deepseek-v4-flash';
    const modelId = model.includes('/') ? model.split('/').at(-1)! : model;
    const baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
    const apiKeyEnv = options.apiKeyEnv ?? 'DEEPSEEK_LLM_TOKEN';
    const protocol = options.protocol === 'openai-responses' ? 'openai-responses' : 'openai-chat';
    const responsesPath = options.responsesPath ?? (protocol === 'openai-responses' ? '/responses' : undefined);
    const defaultPath = protocol === 'openai-responses' ? undefined : '/chat/completions';
    // 内置 server-side search 时不注入客户端 WebSearchTool（避免重复检索）
    const tools = options.noTools ? [] : ['Read', 'Glob', 'Grep', ...(protocol === 'openai-responses' ? [] : ['WebSearch'])];
    // 引导模型主动联网搜索。
    // - openai-responses：web_search 是服务端内置工具（服务端执行、结果经 web_search_call 回传），
    //   模型不能也不应显式“调用”它，只需正常回答并注明来源即可。
    // - openai-chat：WebSearch 是客户端工具，需明确指示模型调用。
    const searchInstruction = protocol === 'openai-responses'
        ? '当需要当前、未知或实时信息时，请进行联网搜索，并基于搜索结果回答，附上来源。'
        : '当需要当前、未知或实时信息时，必须调用 WebSearch 工具进行联网搜索，再基于搜索结果回答，并附上来源。';

    const raw: Record<string, unknown> = {
        version: 1,
        name: 'prompt',
        goal: 'quick prompt',
        providers: [{
            id: 'default',
            implementation: 'openai-compatible',
            base_url: baseUrl,
            default_path: defaultPath,
            responses_path: responsesPath,
            api_key_env: apiKeyEnv,
            models: [{ id: modelId, supports_tools: true }],
        }],
        connections: [{
            id: 'default', provider: 'default', protocol, tiers: { standard: modelId },
        }],
        agents: [{
            id: 'default', connection: 'default', tools,
            web_search: protocol === 'openai-responses',
            system_prompt: [tools.length ? 'Use the available tools to inspect the workspace and execute requests. Report observed results instead of suggesting commands.' : '',
                !options.noTools || protocol === 'openai-responses' ? searchInstruction : 'Answer the user request.'].filter(Boolean).join('\n\n'),
        }],
        tasks: [{ id: 'q', agent: 'default', description: prompt, outputs: { result: 'text' } }],
        result: { task: 'q', output: 'result' },
        workspace: { root: '.', state_dir: '.mindos-prompt' },
        // prompt 直跑默认 native（无需容器）；需要隔离时用 --sandbox oci
        sandbox: { mode: 'native' },
    };
    const config = validateWorkflow(expandWorkflow(raw), true);

    const source = yamlStringify(raw);
    const workspaceRoot = process.cwd();
    const stateDir = resolveStateDir(options, workspaceRoot);
    const workflow: CompiledWorkflow = {
        config,
        workspaceRoot,
        stateDir,
        maxDurationMs: undefined,
    };
    return runLoaded(
        { workflow, source, hash: createHash('sha256').update(source).digest('hex') },
        options,
    );
}

type LoadedWorkflow = Awaited<ReturnType<typeof loadWorkflow>>;

async function runLoaded(loaded: LoadedWorkflow, options: CommandOptions, override?: {
    definition: RunDefinition;
    parameters?: Record<string, JsonValue>;
    useProfileConfig?: boolean;
}): Promise<number> {
    if (options.sandbox) loaded.workflow.config.sandbox = { ...loaded.workflow.config.sandbox, mode: options.sandbox };
    const id = createRunId();
    const store = new RunStore(resolveStateDir(options, loaded.workflow.workspaceRoot));
    loaded.workflow.stateDir = store.stateDir;
    const now = Date.now();
    const manifest: RunManifest = {
        version: 1,
        id,
        ...(override ? { flow: { definition: override.definition, parameters: override.parameters, config: loaded.workflow.config } } : {}),
        name: loaded.workflow.config.name,
        goal: loaded.workflow.config.goal,
        workspaceRoot: loaded.workflow.workspaceRoot,
        configPath: store.configSnapshot(id),
        configHash: loaded.hash,
        status: 'created',
        sessionId: id,
        nodeTaskIds: {},
        taskStatuses: {},
        taskStartedAt: {},
        pendingInteractions: [],
        grants: [],
        lastEventSequence: 0,
        createdAt: now,
        updatedAt: now,
    };
    await store.create(manifest, loaded.source);
    const releaseScheduler = await acquireRunSchedulerLock(store.runDir(id));
    let runtime: CliRuntime | undefined;
    try {
        runtime = await runtimeFor(loaded.workflow, manifest, store, options, 'execute', override?.useProfileConfig);
        await runtime.kernel.createSession({ id, storage: cliStorage(id) });
        const definition = override?.definition ?? compileRunDefinition(loaded.workflow, loaded.hash, runtime.workspaceRoot);
        const spec = toDagRunSpec(definition);
        if (override) {
            for (const node of spec.nodes) Object.assign(node, await runtime.flowCapabilities.bindNode(id,
                node as import('@itookit/llm-flow/contracts').FlowNodeDefinition, spec.nodeDefaults?.[node.id] as never));
        }
        // `submit` resolves as soon as the durable root exists, before the nodes are
        // dispatched, so this handle is live but its node map is still empty here.
        // Node → Task mapping is read from the Session by the monitor; `run.started`
        // reports the graph size from the spec instead of the dispatch snapshot.
        const flow = await runtime.executor.submit(id, spec, override?.parameters);
        manifest.rootTaskId = flow.root.id;
        manifest.status = 'running';
        await store.save(manifest);
        print(options, { type: 'run.started', runId: id, tasks: spec.nodes.length });
        return await monitor(loaded.workflow, manifest, store, runtime, options);
    } catch (error) {
        recordRuntimeDiagnostic('run.failed', error);
        manifest.status = 'failed';
        manifest.error = errorMessage(error);
        manifest.completedAt = Date.now();
        await store.save(manifest);
        printError(options, manifest.error);
        return 1;
    } finally {
        try { await runtime?.dispose(); } finally { releaseScheduler(); }
    }
}

/** 用某个 run 的配置快照重跑整个 DAG（新 run id）。 */
export async function rerunCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    const manifest = await store.load(runId);
    const loaded = await loadSavedWorkflow(store, manifest, false);
    loaded.workflow.workspaceRoot = manifest.workspaceRoot;
    loaded.workflow.stateDir = store.stateDir;
    return runLoaded(loaded, options, manifest.flow ? { ...manifest.flow, useProfileConfig: true } : undefined);
}

/** 把某个 run 的配置快照复制为可编辑文件，供 fork 后修改再 run。 */
export async function forkCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    await store.load(runId);
    const source = await readFile(store.configSnapshot(runId), 'utf8');
    const target = path.join(store.stateDir, 'forks', `${runId}.yml`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, 'utf8');
    print(options, { type: 'run.forked', runId, configPath: target });
    return 0;
}

/** 导出某次运行的配置快照。保留 fork 作为兼容别名。 */
export const exportConfigCommand = forkCommand;

/** 展示 run 的节点级 checkpoint 视图（状态 + 产物路径）。 */
export async function checkpointsCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    const manifest = await store.load(runId);
    const checkpoints = Object.entries(manifest.taskStatuses)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([nodeId, status]) => ({
            nodeId,
            status,
            startedAt: manifest.taskStartedAt?.[nodeId],
            ...(status === 'succeeded'
                ? { artifact: `artifacts/${nodeId.replace(/[^a-zA-Z0-9._-]/g, '_')}/result.json` }
                : {}),
        }));
    print(options, { runId, status: manifest.status, error: manifest.error, checkpoints });
    return 0;
}


/** 展示节点运行状态。保留 checkpoints 作为兼容别名；它不是可恢复的状态快照。 */
export const tasksCommand = checkpointsCommand;

/**
 * 导出一次运行到真实文件：manifest + 每个节点的 transcript 页。
 *
 * transcript 走 `readFlowTaskTranscript` 的字节预算，超出的部分按 `nextOffset`
 * 截断并标记 `truncated`，因此导出文件大小可预期。
 */
export async function exportCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    const manifest = await store.load(runId);
    const loaded = await loadSavedWorkflow(store, manifest);
    loaded.workflow.workspaceRoot = manifest.workspaceRoot;
    loaded.workflow.stateDir = store.stateDir;
    const runtime = await runtimeFor(loaded.workflow, manifest, store, options, 'control');
    try {
        const maxBytes = options.maxBytes ?? 256 * 1024;
        // A killed Run never reached the monitor, so its manifest can lack nodeTaskIds;
        // the Session's task records are the authoritative node→Task mapping.
        const nodeTaskIds = await collectNodeTaskIds(runtime, manifest);
        const rootTaskId = manifest.rootTaskId ?? await findFlowRootTask(runtime.kernel, manifest.sessionId);
        const nodes: Array<{ nodeId: string; taskId: string; transcript?: unknown; error?: string }> = [];
        for (const [nodeId, taskId] of nodeTaskIds) {
            if (!rootTaskId) { nodes.push({ nodeId, taskId }); continue; }
            try {
                nodes.push({ nodeId, taskId, transcript: await readFlowTaskTranscript(
                    runtime.kernel, manifest.sessionId, rootTaskId, taskId, { maxBytes },
                ) });
            } catch (error) {
                nodes.push({ nodeId, taskId, error: error instanceof Error ? error.message : String(error) });
            }
        }
        const document = { version: 1, exportedAt: new Date().toISOString(), maxBytes, run: manifest, nodes };
        const content = JSON.stringify(document, null, 2);
        const target = path.resolve(options.out ?? path.join(store.stateDir, 'exports', `${runId}.json`));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        print(options, { type: 'run.exported', runId, path: target, bytes: Buffer.byteLength(content, 'utf8'),
            nodes: nodes.length, truncated: nodes.filter(node => (node.transcript as { truncated?: boolean } | undefined)?.truncated).length });
        return 0;
    } finally { await runtime.dispose(); }
}

export async function resumeCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    const releaseScheduler = await acquireRunSchedulerLock(store.runDir(runId));
    try { return await resumeLocked(runId, options, store); }
    finally { releaseScheduler(); }
}

/**
 * Find the Run's aggregate root task when the manifest lost it.
 *
 * `runLoaded` persists `rootTaskId` after `executor.submit` returns, so a crash in
 * that window leaves a Run whose root can only be identified through the Session.
 */
async function findFlowRootTask(kernel: Kernel, sessionId: string): Promise<string | undefined> {
    const tasks = await kernel.listSessionTasks(sessionId).catch(() => []);
    const roots = tasks.filter(task => task.labels?.kind === 'flow-root' && task.program?.kind === 'flow.aggregate');
    // A Session holds one Run per submission; if a legacy Run left several roots,
    // the newest one owns the current scheduler checkpoint.
    return roots[roots.length - 1]?.id;
}

/** Node → Task mapping for export: manifest entries first, newest Session Task per node wins. */
async function collectNodeTaskIds(runtime: CliRuntime, manifest: RunManifest): Promise<Map<string, string>> {
    const mapped = new Map<string, string>(Object.entries(manifest.nodeTaskIds ?? {}));
    const tasks = await runtime.kernel.listSessionTasks(manifest.sessionId).catch(() => []);
    const newest = new Map<string, { id: string; createdAt: number }>();
    for (const task of tasks) {
        const nodeId = task.labels?.flowNodeId;
        if (!nodeId) continue;
        const previous = newest.get(nodeId);
        if (!previous || task.createdAt >= previous.createdAt) newest.set(nodeId, { id: task.id, createdAt: task.createdAt });
    }
    for (const [nodeId, task] of newest) mapped.set(nodeId, task.id);
    return new Map([...mapped].sort(([a], [b]) => a.localeCompare(b)));
}

async function resumeLocked(runId: string, options: CommandOptions, store: RunStore): Promise<number> {
    const manifest = await store.load(runId);
    if (isTerminal(manifest.status)) {
        print(options, manifest);
        return manifest.status === 'succeeded' ? 0 : 1;
    }
    const loaded = await loadSavedWorkflow(store, manifest);
    loaded.workflow.workspaceRoot = manifest.workspaceRoot;
    loaded.workflow.stateDir = store.stateDir;
    if (options.sandbox) loaded.workflow.config.sandbox = { ...loaded.workflow.config.sandbox, mode: options.sandbox };
    const runtime = await runtimeFor(loaded.workflow, manifest, store, options);
    try {
        // A crash between Task creation and manifest persistence leaves rootTaskId
        // unset; recover it from the Session's flow-root task instead of failing.
        if (!manifest.rootTaskId) {
            manifest.rootTaskId = await findFlowRootTask(runtime.kernel, manifest.sessionId);
            if (!manifest.rootTaskId) throw new Error('Run root task is missing and the Session has no flow-root task');
            await store.save(manifest);
        }
        await runtime.executor.resume(manifest.sessionId, manifest.rootTaskId);
        manifest.status = 'running';
        await store.save(manifest);
        return await monitor(loaded.workflow, manifest, store, runtime, options);
    } finally {
        await runtime.dispose();
    }
}

export async function respondCommand(
    runId: string,
    requestId: string,
    options: CommandOptions,
): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    const manifest = await store.load(runId);
    const pending = manifest.pendingInteractions.find(item => item.interactionId === requestId);
    if (!pending) throw new Error(`Pending interaction not found: ${requestId}`);
    const loaded = await loadSavedWorkflow(store, manifest);
    loaded.workflow.workspaceRoot = manifest.workspaceRoot;
    loaded.workflow.stateDir = store.stateDir;
    const runtime = await runtimeFor(loaded.workflow, manifest, store, options, 'control');
    try {
        await runtime.kernel.respondInteraction(manifest.sessionId, pending.taskId, {
            interactionId: requestId,
            value: resolveRespondValue(options),
        });
        manifest.pendingInteractions = manifest.pendingInteractions.filter(item => item !== pending);
        manifest.status = 'running';
        await store.save(manifest);
        print(options, { type: 'interaction.resolved', runId, requestId });
        return 0;
    } finally {
        await runtime.dispose();
    }
}

export async function deleteCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    const releaseScheduler = await acquireRunSchedulerLock(store.runDir(runId));
    try {
        const manifest = await store.load(runId);
        if (!isTerminal(manifest.status)) {
            throw new Error(`Run ${runId} is still ${manifest.status}; cancel it before deleting`);
        }
        // 本地锁只对本地文件系统有效；共享存储上必须再看通用调度租约，否则会删掉另一个
        // 宿主正在推进的 Run（manifest 在本地视角可能已经过期）。
        if (manifest.rootTaskId) {
            await markRunDeleted({
                vfsRoot: resolveProfileVfsRoot(options),
                sessionId: manifest.sessionId,
                rootTaskId: manifest.rootTaskId,
            });
        }
        await store.delete(runId);
        print(options, { type: 'run.deleted', runId });
        return 0;
    } finally { releaseScheduler(); }
}

export async function cancelCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    const manifest = await store.load(runId);
    if (isTerminal(manifest.status)) return 0;
    const loaded = await loadSavedWorkflow(store, manifest);
    loaded.workflow.workspaceRoot = manifest.workspaceRoot;
    loaded.workflow.stateDir = store.stateDir;
    const runtime = await runtimeFor(loaded.workflow, manifest, store, options);
    try {
        for (const taskId of Object.values(manifest.nodeTaskIds)) {
            await (await runtime.kernel.openTask(taskId)).cancel('Cancelled by CLI').catch(() => {});
        }
        if (manifest.rootTaskId) await (await runtime.kernel.openTask(manifest.rootTaskId)).cancel('Cancelled by CLI').catch(() => {});
        manifest.status = 'cancelled';
        manifest.completedAt = Date.now();
        await store.save(manifest);
        print(options, { type: 'run.cancelled', runId });
        return 0;
    } finally {
        await runtime.dispose();
    }
}

export async function statusCommand(runId: string | undefined, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    if (runId) print(options, await store.load(runId));
    else print(options, await store.list());
    return 0;
}

export async function logsCommand(runId: string, options: CommandOptions): Promise<number> {
    const store = new RunStore(resolveStateDir(options));
    let offset = 0;
    while (true) {
        const content = await readFile(store.eventsPath(runId), 'utf8').catch(() => '');
        if (content.length > offset) process.stdout.write(content.slice(offset));
        offset = content.length;
        if (!options.follow || isTerminal((await store.load(runId)).status)) return 0;
        await delay(500);
    }
}

export async function doctorCommand(options: CommandOptions): Promise<number> {
    const result = await sandboxDoctor();
    print(options, result);
    return result.available ? 0 : 1;
}

async function monitor(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    store: RunStore,
    runtime: CliRuntime,
    options: CommandOptions,
): Promise<number> {
    if (!manifest.rootTaskId) throw new Error('Run root task is missing');
    const root = await runtime.kernel.openTask(manifest.rootTaskId);
    const interruption = watchInterrupt();
    let lastSnapshot = '';
    let stallSince = Date.now();
    let stallWarned = false;
    try {
        while (true) {
            const result = await monitorIteration(workflow, manifest, store, runtime, options, root, interruption);
            if (result !== undefined) return result;
            const snapshot = progressSnapshot(manifest);
            if (snapshot === lastSnapshot) {
                if (!stallWarned && Date.now() - stallSince > STALL_WARN_MS) {
                    stallWarned = true;
                    printStallDiagnostic(manifest, options);
                }
            } else {
                lastSnapshot = snapshot;
                stallSince = Date.now();
                stallWarned = false;
            }
            await delay(150);
        }
    } finally {
        interruption.dispose();
    }
}

function progressSnapshot(manifest: RunManifest): string {
    return `${manifest.lastEventSequence}|${Object.entries(manifest.taskStatuses)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, status]) => `${id}:${status}`).join(',')}|${manifest.pendingInteractions.length}`;
}

function printStallDiagnostic(manifest: RunManifest, options: CommandOptions): void {
    const statuses = Object.entries(manifest.taskStatuses)
        .map(([id, status]) => `${id}:${status}`).join(' ') || '(none)';
    printError(options, `No run progress for ${STALL_WARN_MS / 1000}s. Task statuses: ${statuses}`);
}

/**
 * Decide the Run's indeterminate Effects before the monitor keeps polling.
 *
 * A crash can leave an external call whose outcome cannot be proven: the kernel
 * reconciles a lost Effect lease to `indeterminate`. The protocol forbids treating
 * "unknown" as "not executed", so the Run blocks until the host authorizes a replay
 * (`--retry-indeterminate`) or cancels it.
 */
async function decideBlockedEffects(
    manifest: RunManifest,
    store: RunStore,
    runtime: CliRuntime,
    options: CommandOptions,
    tasks: Awaited<ReturnType<Kernel['listSessionTasks']>>,
): Promise<number | undefined> {
    const blocked = collectBlockedEffects(tasks);
    if (!blocked.length) {
        if (manifest.blockedEffects?.length) { manifest.blockedEffects = undefined; await store.save(manifest); }
        return undefined;
    }
    if (!options.retryIndeterminate) {
        manifest.blockedEffects = blocked;
        manifest.status = 'waiting';
        await store.save(manifest);
        printBlockedHint(manifest, options);
        return 3;
    }
    for (const item of blocked) {
        const task = await runtime.kernel.openTask(item.taskId);
        // Deterministic requestId: re-running the same decision is a no-op, and a
        // conflicting decision for the same Effect is rejected by the kernel.
        await task.resolveEffect({
            requestId: `resolve:${item.effectId}:retry`, effectId: item.effectId, outcome: { type: 'retry' },
        });
        print(options, { type: 'run.effect.retried', runId: manifest.id, taskId: item.taskId, effectId: item.effectId });
    }
    manifest.blockedEffects = undefined;
    await store.save(manifest);
    return undefined;
}

function collectBlockedEffects(tasks: Awaited<ReturnType<Kernel['listSessionTasks']>>): BlockedEffect[] {
    return tasks.flatMap(task => Object.entries(task.effects ?? {})
        .filter(([, effect]) => effect.status === 'indeterminate')
        .map(([effectId, effect]) => ({
            taskId: task.id,
            effectId,
            kind: effect.request.kind,
            ...(effect.error?.message ? { error: effect.error.message } : {}),
        })));
}

function printBlockedHint(manifest: RunManifest, options: CommandOptions): void {
    const effects = manifest.blockedEffects ?? [];
    const resume = `mindos resume ${manifest.id} --state-dir ${resolveStateDir(options)} --retry-indeterminate`;
    if (options.json) {
        process.stderr.write(`${JSON.stringify({ type: 'run.blocked', runId: manifest.id, effects, resume })}\n`);
        return;
    }
    process.stderr.write(
        `运行被阻塞：${effects.length} 个外部 Effect 的结果无法核对（${effects.map(item => `${item.effectId}@${item.taskId}`).join(', ')}）。\n` +
        `确认可以安全重放后继续：${resume}\n`,
    );
}

async function monitorIteration(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    store: RunStore,
    runtime: CliRuntime,
    options: CommandOptions,
    root: TaskHandle,
    interruption: InterruptWatcher,
): Promise<number | undefined> {
    if (interruption.signal) return cancelInterrupted(workflow, manifest, store, runtime, root, interruption.signal, options);
    await collectEvents(manifest, store, runtime, options);
    // One session task listing per tick: the Run can hold hundreds of Tasks and each
    // listing walks task storage, so status refresh and Effect decisions share it.
    const tasks = await runtime.kernel.listSessionTasks(manifest.sessionId);
    await refreshTaskStatuses(workflow, manifest, runtime, tasks);
    await runtime.syncHistory(tasks);
    const blocked = await decideBlockedEffects(manifest, store, runtime, options, tasks);
    if (blocked !== undefined) return blocked;
    const interaction = await processInteractions(manifest, store, runtime, options);
    if (interaction !== undefined) return interaction;
    const exit = await root.poll();
    if (exit) {
        // Nodes may finish between the tick snapshot and root.poll; persist the final projection.
        await collectEvents(manifest, store, runtime, options);
        const finalTasks = await runtime.kernel.listSessionTasks(manifest.sessionId);
        await refreshTaskStatuses(workflow, manifest, runtime, finalTasks);
        await runtime.syncHistory(finalTasks);
        return finishRun(workflow, manifest, store, exit, options);
    }
    if (workflow.maxDurationMs && Date.now() - manifest.createdAt > workflow.maxDurationMs) {
        return cancelExpiredRun(workflow, manifest, store, runtime, root);
    }
    await store.save(manifest);
    return undefined;
}

function watchInterrupt(): InterruptWatcher {
    const watcher: InterruptWatcher = { dispose };
    const interrupt = () => { watcher.signal = 'SIGINT'; };
    const terminate = () => { watcher.signal = 'SIGTERM'; };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    function dispose(): void {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
    }
    return watcher;
}

async function cancelInterrupted(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    store: RunStore,
    runtime: CliRuntime,
    root: TaskHandle,
    signal: NodeJS.Signals,
    options: CommandOptions,
): Promise<number> {
    await root.cancel(`Interrupted by ${signal}`);
    manifest.status = 'cancelled';
    manifest.error = `Interrupted by ${signal}`;
    manifest.completedAt = Date.now();
    await projectTerminalStatuses(workflow, manifest, runtime);
    await store.save(manifest);
    printError(options, manifest.error);
    return signal === 'SIGINT' ? 130 : 143;
}

async function cancelExpiredRun(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    store: RunStore,
    runtime: CliRuntime,
    root: TaskHandle,
): Promise<number> {
    await root.cancel('Run duration exceeded');
    manifest.status = 'failed';
    manifest.error = 'Run duration exceeded';
    manifest.completedAt = Date.now();
    await projectTerminalStatuses(workflow, manifest, runtime);
    await store.save(manifest);
    return 1;
}

/**
 * Record the node states a cancellation just committed. Without this the manifest is
 * saved with whatever the last tick projected (often nothing on a first-tick SIGINT),
 * so `checkpoints`/`tasks` report a terminal Run with no node statuses.
 *
 * Cancelling the root Task only accepts the request: the Kernel commits the child
 * decisions afterwards, so a single listing can persist a terminal Run whose node still
 * reads `waiting`. Poll briefly for the node Tasks to settle; the wait is bounded so a
 * device that never confirms the stop cannot hang the exit path.
 */
async function projectTerminalStatuses(workflow: CompiledWorkflow, manifest: RunManifest, runtime: CliRuntime): Promise<void> {
    const deadline = Date.now() + PROJECTION_SETTLE_MS;
    try {
        for (;;) {
            const tasks = await runtime.kernel.listSessionTasks(manifest.sessionId);
            await refreshTaskStatuses(workflow, manifest, runtime, tasks);
    await runtime.syncHistory(tasks);
            const unsettled = tasks.some(task => task.labels?.flowNodeId && !isTerminalTaskStatus(task.status));
            if (!unsettled || Date.now() >= deadline) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    } catch { /* The Run is already terminal; a projection failure must not change the outcome. */ }
}

async function processInteractions(
    manifest: RunManifest,
    store: RunStore,
    runtime: CliRuntime,
    options: CommandOptions,
): Promise<number | undefined> {
    if (!manifest.pendingInteractions.length) return undefined;
    manifest.status = 'waiting';
    await store.save(manifest);
    // --json implies headless: never block on an interactive stdin prompt under a machine-readable
    // stream, or CI would hang. Surface the resume/respond commands instead.
    if (options.headless || options.json) {
        // Persist the scheduler checkpoint before the headless process exits, so
        // resume/respond reattaches to the same Task instances instead of resubmitting nodes.
        try { await runtime.waitForCheckpoint(Object.values(manifest.nodeTaskIds)); }
        catch (error) { printError(options, errorMessage(error)); return 1; }
        printInteractionHint(manifest, options);
        return 3;
    }
    await resolveInteractive(manifest, runtime, store);
    return undefined;
}

function printInteractionHint(manifest: RunManifest, options: CommandOptions): void {
    const requestIds = manifest.pendingInteractions.map(item => item.interactionId);
    const resume = `mindos resume ${manifest.id} --state-dir ${resolveStateDir(options)}`;
    if (options.json) {
        process.stderr.write(`${JSON.stringify({ type: 'run.waiting', runId: manifest.id, requestIds, resume })}\n`);
        return;
    }
    process.stderr.write(
        `等待人工输入 ${requestIds.join(', ')}。批准后继续：${resume}\n` +
        requestIds.map(id => `  mindos respond ${manifest.id} ${id} --approve\n`).join(''),
    );
}

async function collectEvents(
    manifest: RunManifest,
    store: RunStore,
    runtime: CliRuntime,
    options: CommandOptions,
): Promise<void> {
    const events = await runtime.kernel.eventList(manifest.sessionId, manifest.lastEventSequence);
    for (const event of events) {
        manifest.lastEventSequence = event.sequence;
        updateInteractionProjection(manifest, event);
        await store.appendEvent(manifest.id, event);
        renderEvent(manifest, event, options);
    }
}

function updateInteractionProjection(manifest: RunManifest, event: EventEnvelope): void {
    if (event.type === 'task.interaction.requested' && event.taskId) {
        const request = event.payload as Omit<PendingInteraction, 'taskId' | 'interactionId'> & { id?: string };
        if (!request.id || manifest.pendingInteractions.some(item => item.interactionId === request.id)) return;
        manifest.pendingInteractions.push({
            taskId: event.taskId,
            interactionId: request.id,
            kind: request.kind,
            prompt: request.prompt,
            payload: request.payload,
        });
    }
    if (event.type === 'task.interaction.resolved') {
        const id = (event.payload as { interactionId?: string })?.interactionId;
        manifest.pendingInteractions = manifest.pendingInteractions.filter(item => item.interactionId !== id);
    }
}

async function refreshTaskStatuses(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    runtime: CliRuntime,
    tasks: Awaited<ReturnType<Kernel['listSessionTasks']>>,
): Promise<void> {
    for (const task of tasks) {
        const nodeId = task.labels?.flowNodeId;
        if (!nodeId) continue;
        manifest.nodeTaskIds[nodeId] = task.id;
        manifest.taskStatuses[nodeId] = task.status;
        if (task.attemptCount > 0) (manifest.taskStartedAt ??= {})[nodeId] ??= Date.now();
        await enforceTaskTimeout(workflow, manifest, runtime, nodeId, task.id, task.status);
    }
}

async function enforceTaskTimeout(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    runtime: CliRuntime,
    nodeId: string,
    taskId: string,
    status: string,
): Promise<void> {
    if (isTerminalTaskStatus(status)) return;
    const timeout = parseDuration(workflow.config.tasks.find(task => task.id === nodeId)?.timeout);
    const startedAt = manifest.taskStartedAt?.[nodeId];
    if (!timeout || !startedAt || Date.now() - startedAt <= timeout) return;
    await (await runtime.kernel.openTask(taskId)).cancel(`Task ${nodeId} duration exceeded`);
    manifest.taskStatuses[nodeId] = 'cancelled';
}

async function resolveInteractive(manifest: RunManifest, runtime: CliRuntime, store: RunStore): Promise<void> {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
        while (manifest.pendingInteractions.length) {
            const request = manifest.pendingInteractions[0];
            const detail = request.payload ? `\n${JSON.stringify(request.payload, null, 2)}` : '';
            const answer = await terminal.question(`${request.prompt}${detail}\n${request.kind === 'approval' ? '批准？[y/N] ' : '> '}`);
            const value = request.kind === 'approval' ? /^(y|yes)$/i.test(answer.trim()) : answer;
            await runtime.kernel.respondInteraction(manifest.sessionId, request.taskId, {
                interactionId: request.interactionId,
                value,
            });
            manifest.pendingInteractions.shift();
            manifest.status = 'running';
            await store.save(manifest);
        }
    } finally {
        terminal.close();
    }
}

async function finishRun(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    store: RunStore,
    exit: ExitRecord<unknown>,
    options: CommandOptions,
): Promise<number> {
    manifest.completedAt = Date.now();
    if (exit.status !== 'succeeded') {
        manifest.status = exit.status === 'cancelled' ? 'cancelled' : 'failed';
        manifest.error = exit.error?.message ?? `Run ${exit.status}`;
        await store.save(manifest);
        printError(options, manifest.error);
        return 1;
    }
    await store.writeArtifacts(manifest.id, exit.output);
    const selected = selectFinalResult(
        exit.output,
        workflow.config.result.task,
        workflow.config.result.output,
    );
    // result 任务失败或无输出（例如被 on_failure 容忍的失败仍指向该任务）→ run 失败。
    if (selected === undefined || selected === null) {
        manifest.status = 'failed';
        manifest.error = `Result task ${workflow.config.result.task} produced no output`;
        await store.save(manifest);
        printError(options, manifest.error);
        return 1;
    }
    manifest.resultPath = await store.writeResult(manifest.id, selected);
    manifest.status = 'succeeded';
    await store.save(manifest);
    print(options, { type: 'run.succeeded', runId: manifest.id, result: selected });
    return 0;
}

async function loadSavedWorkflow(store: RunStore, manifest: RunManifest, checkEnvironment = true): Promise<LoadedWorkflow> {
    if (!manifest.flow) return loadWorkflow(store.configSnapshot(manifest.id), checkEnvironment);
    return {
        workflow: { config: structuredClone(manifest.flow.config), workspaceRoot: manifest.workspaceRoot, stateDir: store.stateDir },
        source: await readFile(store.configSnapshot(manifest.id), 'utf8'),
        hash: manifest.configHash,
    };
}

async function runtimeFor(
    workflow: CompiledWorkflow,
    manifest: RunManifest,
    store: RunStore,
    options: CommandOptions,
    mode: 'execute' | 'control' = 'execute',
    useProfileConfig = Boolean(manifest.flow),
): Promise<CliRuntime> {
    await stat(workflow.workspaceRoot);
    const vfsRoot = resolveProfileVfsRoot(options);
    process.stderr.write(`[profile] mindos root: ${vfsRoot}\n`);
    return createCliRuntime(workflow, manifest, async grants => {
        manifest.grants = grants;
        await store.save(manifest);
    }, vfsRoot, mode, { setHome: options.setHome, addDir: options.addDir, grantMemory: options.grantMemory, useProfileConfig });
}

function renderEvent(manifest: RunManifest, event: EventEnvelope, options: CommandOptions): void {
    if (options.json || options.headless) {
        // 默认过滤高频/低层事件（stream 增量、task 生命周期），--verbose 则全量输出
        if (!options.verbose && isQuietEvent(event)) return;
        process.stdout.write(`${JSON.stringify({ version: 1, runId: manifest.id, ...event })}\n`);
        return;
    }
    if (event.type === 'stream:content') {
        const payload = event.payload as { delta?: string } | string;
        process.stdout.write(typeof payload === 'string' ? payload : payload?.delta ?? '');
        return;
    }
    if (/^(task\.(created|succeeded|failed)|tool:|budget:)/.test(event.type)) {
        process.stdout.write(`[${event.sequence}] ${event.type}\n`);
    }
}

/** 判断是否默认过滤的"噪音"事件（运行状态 / stream 增量），`--verbose` 时保留。 */
function isQuietEvent(event: EventEnvelope): boolean {
    // task 生命周期事件
    if (/^task\.(created|leased|waiting|modified|heartbeat|ready)$/.test(event.type)) return true;
    if (event.type === 'agent.event') {
        const t = (event.payload as { type?: string } | undefined)?.type;
        // stream 增量 + 工具运行中状态，默认不写（看结果用）
        if (t === 'stream:thinking' || t === 'stream:content' || t === 'stream:thinking:stop'
            || t === 'tool:running') return true;
    }
    return false;
}

export function resolveRespondValue(options: CommandOptions): JsonValue {
    const modes = [options.approve, options.deny, options.value !== undefined].filter(Boolean);
    if (modes.length !== 1) {
        throw new Error('respond requires exactly one of --approve, --deny, or --value');
    }
    if (options.approve) return true;
    if (options.deny) return false;
    try { return JSON.parse(options.value!) as JsonValue; } catch { return options.value!; }
}

function resolveStateDir(options: CommandOptions, _workspaceRoot?: string): string {
    if (options.stateDir) return path.resolve(options.stateDir);
    return path.join(resolveProfileRoot(options.profile), 'var', 'lib', 'cli-runs');
}

/** VFS 数据根：Run 的 Session/内核状态（含调度租约）都落在这里。 */
function resolveProfileVfsRoot(options: CommandOptions): string {
    return options.stateDir ? path.resolve(options.stateDir) : resolveProfileRoot(options.profile);
}

function createRunId(): string {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function print(options: CommandOptions, value: unknown): void {
    if (options.json || options.headless) process.stdout.write(`${JSON.stringify(value)}\n`);
    else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function printError(options: CommandOptions, message: string): void {
    recordRuntimeDiagnostic('command.error', message);
    if (options.json || options.headless) process.stderr.write(`${JSON.stringify({ type: 'error', message })}\n`);
    else process.stderr.write(`错误：${message}\n`);
}

function isTerminal(status: RunManifest['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
