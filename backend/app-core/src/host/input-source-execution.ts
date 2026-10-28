import {createModuleLogger, sha256Hex} from '@itookit/common';
import {InputSourceCommand, type InputSourceExecution, type InputSourceReceipt} from '@itookit/app-contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {createSessionId, sessionDirectoryStorage, type CommandBus, type ISessionRepository} from '@itookit/llm-session';
import {FlowCommand, assertRootCallable, type FlowRevision} from '@itookit/llm-flow/contracts';
import {KernelError, KernelErrorCode, type Kernel} from '@itookit/durable-kernel';
import type {IFileSystem} from '@itookit/vfs-core';
import type {ToolCommandOption} from '@itookit/llm-session/contracts';
interface Options {
    commands: CommandBus; fs: IFileSystem; kernel: Kernel; repository: ISessionRepository; projects?: ProjectService;
    tools(): Promise<ToolCommandOption[]>; prepare?(id: string): Promise<void>; writable?(id: string): Promise<boolean>;
}
interface Intent {input: InputSourceExecution; flow: FlowRevision; sessionId: string; createdAt: number; taskId?: string}
const path = '/var/lib/input-sources.seq', log = createModuleLogger('input-source');
export function registerInputSourceExecution(options: Options) {
    const service = new InputSourceExecutionService(options);
    const registrations = [options.commands.register(InputSourceCommand.Catalog, () => options.tools()),
        options.commands.register(InputSourceCommand.Execute, args => service.execute(args as InputSourceExecution)),
        options.commands.register(InputSourceCommand.Inspect, args => service.inspect((args as {requestId: string}).requestId))];
    return {dispose() {registrations.forEach(item => item.dispose());}};
}
class InputSourceExecutionService {
    constructor(private options: Options) {}
    async inspect(requestId: string): Promise<InputSourceReceipt | null> {
        this.validateId(requestId);
        if (!await this.options.fs.driver.exists(path)) return null;
        const raw = await this.options.fs.meta.seq!.getEntry(path, requestId);
        if (!raw) return null;
        const intent: Intent = JSON.parse(raw);
        if (intent.taskId) return {sessionId: intent.sessionId, taskId: intent.taskId};
        const runs = await this.options.commands.execute<Array<{taskId: string; invocation?: {invocationId: string}}>>(FlowCommand.RunList, {sessionId: intent.sessionId});
        return {sessionId: intent.sessionId, taskId: runs.find(run => run.invocation?.invocationId === requestId)?.taskId};
    }
    async execute(input: InputSourceExecution): Promise<InputSourceReceipt> {
        const started = Date.now(); let stage = 'validate';
        try {
            this.validateId(input.requestId); input = structuredClone(input);
            const flow = await this.definition(input);
            stage = 'reserve'; const intent = await this.reserve(input, flow);
            const receipt = await this.inspect(input.requestId); if (receipt?.taskId) return receipt;
            stage = 'session'; await this.session(intent);
            stage = 'submit'; const source = input.source;
            const result = await this.options.commands.execute<{taskId: string}>(FlowCommand.RunStart, {sessionId: intent.sessionId, flow: intent.flow,
                ...(source.kind === 'flow' ? {parameters: source.parameters, connectionId: source.connectionId, connectionBindings: source.connectionBindings} : {}),
                invocation: {requestId: input.requestId, invocationId: input.requestId, flowId: flow.id, revision: flow.revision, digest: flow.digest, name: flow.name, createdAt: intent.createdAt}});
            await this.options.fs.meta.seq!.setEntry(path, input.requestId, JSON.stringify({...intent, taskId: result.taskId}));
            log.info('input-source.execute', {operationId: input.requestId, stage: 'complete', result: 'success', sessionId: intent.sessionId, taskId: result.taskId, durationMs: Date.now() - started});
            return {sessionId: intent.sessionId, taskId: result.taskId};
        } catch (error) {
            log.warn('input-source.execute', {operationId: input.requestId, stage, result: 'failure', code: failureCode(error, stage), durationMs: Date.now() - started}); throw error;
        }
    }
    private validateId(id: string): void {if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) throw new Error('INPUT_SOURCE_ID_REQUIRED');}
    private async definition(input: InputSourceExecution): Promise<FlowRevision> {
        const source = input.source;
        if (source.kind === 'flow') {
            const flow = await this.options.commands.execute<FlowRevision>(FlowCommand.RevisionGet, {id: source.flowId, revision: source.revision});
            if (!flow || flow.digest !== source.digest) throw new Error('FLOW_REVISION_CHANGED');
            assertRootCallable(flow); return flow;
        }
        if (source.kind !== 'tool' || !(await this.options.tools()).some(tool => tool.id === source.toolId && (tool.version ?? '1') === source.toolVersion)) throw new Error('TOOL_COMMAND_UNAVAILABLE');
        if (!source.args || typeof source.args !== 'object' || Array.isArray(source.args)) throw new Error('TOOL_COMMAND_ARGUMENTS_INVALID');
        return {id: `input-${input.requestId}`, revision: 1, digest: await sha256Hex(JSON.stringify(source)), name: source.toolId,
            nodes: [{id: 'source', name: source.toolId, plugin: 'builtin.tool', pluginVersion: '1.0.0', capabilities: [source.toolId], inputs: {},
                config: {toolId: source.toolId, toolVersion: source.toolVersion, args: source.args, approval: 'all'}}], edges: []} as unknown as FlowRevision;
    }
    private async reserve(input: InputSourceExecution, flow: FlowRevision): Promise<Intent> {
        const fs = this.options.fs;
        if (!await fs.driver.exists(path)) {
            try {await fs.driver.createFile({parentPath: '/var/lib', name: 'input-sources.seq', type: 'seqfile', recursive: true});}
            catch (error) {if (!await fs.driver.exists(path)) throw error;}
        }
        let intent!: Intent;
        if (!fs.meta.seq?.transaction) throw new Error('INPUT_SOURCE_STORAGE_UNAVAILABLE');
        await fs.meta.seq.transaction(async tx => {
            const raw = await tx.getEntry(path, input.requestId);
            if (raw) {
                intent = JSON.parse(raw);
                if (JSON.stringify(intent.input) !== JSON.stringify(input)) throw new Error('INPUT_SOURCE_REQUEST_CONFLICT');
            } else {
                intent = {input, flow, sessionId: createSessionId(), createdAt: Date.now()};
                await tx.setEntry(path, input.requestId, JSON.stringify(intent));
            }
        });
        return intent;
    }
    private async session(intent: Intent): Promise<void> {
        const o = this.options, scope = intent.input.scope;
        const project = scope.projectId ? await o.projects?.get(scope.projectId)
            : scope.sessionId ? await o.projects?.forFolder((await o.repository.getManifest(scope.sessionId)).folder) : await o.projects?.personal();
        await o.repository.ensureSession(intent.sessionId, intent.flow.name, 'tauri', project ? await o.projects!.sessionFolder(project) : null);
        await o.prepare?.(intent.sessionId);
        if (o.writable && !await o.writable(intent.sessionId)) throw new Error('SESSION_READ_ONLY');
        try {await o.kernel.openSession(intent.sessionId, sessionDirectoryStorage(intent.sessionId));}
        catch (error) {if (!(error instanceof KernelError) || error.code !== KernelErrorCode.SESSION_NOT_FOUND) throw error;
            await o.kernel.createSession({id: intent.sessionId, storage: sessionDirectoryStorage(intent.sessionId)});}
    }
}

function failureCode(error: unknown, stage: string): string {
    const value = error as {code?: unknown; message?: unknown};
    const code = value?.code ?? value?.message;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : `INPUT_SOURCE_${stage.toUpperCase()}_FAILED`;
}
