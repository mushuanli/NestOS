import {IndependentCallResponses} from './independent-call-responses';
import {readIndependentCallInteractions} from './independent-call-interactions';
import {hasFlowControlTree} from '@itookit/llm-flow/contracts';
import {IndependentCallControls} from './independent-call-controls';
import {taskStat, KernelError, KernelErrorCode, type Kernel, type JsonValue} from '@itookit/durable-kernel';
import {sha256Hex} from '@itookit/llm-context';
import {IndependentCallCommand, type IndependentCallControlQuery, type IndependentCallInput, type IndependentCallView, type IndependentCallExecutionState, type IndependentCallListQuery, type IndependentCallReceipt, type IndependentCallSubmitter} from '../contracts/independent-calls';
import type {ICommandBus} from '../contracts/command-bus';
import type {SubmissionRequest} from '../contracts/submission';
import type {Round} from '../contracts/conversation';
import type {ISessionRepository} from '../persistence/types';
import type {ContentTransferService} from './content-transfers';
import {assertSubmissionBinding, submissionInstruction} from './submission-input';
import {instructionDigest, prepareInstruction} from './instruction-queue-rules';
import {readSubmissionReceipt} from './submission-receipt';
import {AttachmentProcessor} from './attachment-processor';
import {freezeAttachments, readVerifiedAttachment} from './attachment-integrity';
import {createSessionHost, type SessionHostPorts} from '../utils/host-ports';

interface CallRoute {createdAt?: number; head?: string | null; digest: string; input: IndependentCallInput; childRequest: SubmissionRequest; executionSessionId?: string}
interface Options {
    kernel: Kernel; repository: ISessionRepository; transfers: Pick<ContentTransferService, 'createChild'>;
    submit: IndependentCallSubmitter; prepareExecution?(sessionId: string): Promise<void>; canWrite?(sessionId: string): Promise<boolean>; hostPorts?: SessionHostPorts;
}
const prefix = 'conversation/call/';
/** A durable route only: acceptance and execution remain owned by the child's existing queue and history. */
export class IndependentCallService {
    private readonly host;
    constructor(private readonly options: Options) {this.host = createSessionHost(options.hostPorts);}
    register(commands: ICommandBus): void {
        commands.register(IndependentCallCommand.Submit, value => this.submit(value as IndependentCallInput));
        commands.register(IndependentCallCommand.Inspect, value => this.inspect(value as IndependentCallInput));
        commands.register(IndependentCallCommand.List, value => this.list(value as IndependentCallListQuery));
        new IndependentCallControls({kernel: this.options.kernel, commands, logger: this.host.logger,
            canWrite: this.options.canWrite, resolve: query => this.controlTarget(query)}).register();
        new IndependentCallResponses({kernel: this.options.kernel, commands, logger: this.host.logger,
            canWrite: this.options.canWrite, resolve: query => this.controlTarget(query)}).register();
    }
    async submit(supplied: IndependentCallInput): Promise<IndependentCallReceipt> {
        const input = structuredClone(supplied), started = Date.now(); let stage = 'validate', outcome = 'failure', code: string | undefined;
        const suppliedId = input?.request?.submission?.id;
        const operationId = typeof suppliedId === 'string' && /^[\w-]{1,128}$/.test(suppliedId) ? suppliedId : undefined;
        try {
            const identity = await this.identity(input); stage = 'route';
            await this.options.repository.getManifest(identity.sessionId);
            await this.options.prepareExecution?.(identity.sessionId);
            await this.writable(identity.sessionId);
            let route = await this.route(input, identity.digest);
            const child = await this.options.transfers.createChild({sessionId: identity.sessionId,
                requestId: `call-${await sha256Hex(identity.id)}`, title: input.title, transfer: input.transfer});
            route = await this.bindRoute(route, child.sessionId); stage = 'admission';
            const result = await this.admit(route); outcome = result.status; return result;
        } catch (error) {
            const suppliedCode = (error as {code?: unknown})?.code;
            code = typeof suppliedCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(suppliedCode) ? suppliedCode : 'CALL_INDEPENDENT_FAILED';
            throw error;
        } finally {
            const detail = {operation: 'call.independent', operationId, stage, outcome, code, durationMs: Date.now() - started};
            if (outcome === 'failure') this.host.logger.warn('Independent call observation', detail);
            else this.host.logger.info('Independent call observation', detail);
        }
    }
    private async admit(route: CallRoute): Promise<IndependentCallReceipt> {
        const previous = await this.receipt(route);
        if (previous.status === 'accepted') return previous;
        await this.copyAttachments(route);
        try {
            const accepted = await this.options.submit(structuredClone(route.childRequest));
            if (accepted !== route.input.request.submission!.id) throw failure('CALL_RECEIPT_MISMATCH');
        } catch (error) {
            const observed = await this.receipt(route);
            if (observed.status !== 'accepted') throw error;
        }
        return this.receipt(route);
    }
    async inspect(supplied: IndependentCallInput): Promise<IndependentCallReceipt> {
        const input = structuredClone(supplied), identity = await this.identity(input);
        const stored = await this.readRoute(identity.sessionId, identity.id);
        if (!stored) return {operationId: identity.id, callerSessionId: identity.sessionId, status: 'unknown'};
        return this.receipt(this.match(stored.value, identity.digest));
    }
    async list(query: IndependentCallListQuery): Promise<IndependentCallView[]> {
        const started = Date.now();
        try {return await this.readViews(query);}
        catch (error) {
            const code = (error as {code?: unknown})?.code;
            this.host.logger.warn('Independent call query failed', {operation: 'call.list', stage: 'read', outcome: 'failure',
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_QUERY_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    }
    private async readViews(query: IndependentCallListQuery): Promise<IndependentCallView[]> {
        if (!query || typeof query.sessionId !== 'string' || query.branchId !== undefined && typeof query.branchId !== 'string'
            || Object.keys(query).some(key => !['sessionId', 'branchId'].includes(key))) throw failure('CALL_QUERY_INVALID');
        query = structuredClone(query);
        const manifest = await this.options.repository.getManifest(query.sessionId);
        if (query.branchId !== undefined && !Object.hasOwn(manifest.branches, query.branchId)) throw failure('CALL_BRANCH_CHANGED');
        const entries = await this.options.kernel.listShared(query.sessionId, prefix).catch(error => {
            if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return []; throw error;
        });
        const views: IndependentCallView[] = [];
        for (const entry of entries) {
            const route = entry.value as unknown as CallRoute;
            if (route.input.request.expectedSessionId !== query.sessionId) throw failure('CALL_ROUTE_CONFLICT');
            if (query.branchId !== undefined && route.input.request.expectedBranch !== query.branchId) continue;
            const {receipt, round} = await this.observe(route);
            const executionView = await this.executionProjection(receipt);
            views.push({input: structuredClone(route.input), receipt, createdAt: route.createdAt ?? 0, head: route.head ?? null, ...executionView,
                ...(round ? {status: round.status, summary: outputSummary(round)} : {})});
        }
        return views.sort((a, b) => a.createdAt - b.createdAt || a.receipt.operationId.localeCompare(b.receipt.operationId));
    }
    private async controlTarget(query: IndependentCallControlQuery) {
        const saved = await this.readRoute(query.sessionId, query.callId);
        if (!saved) throw failure('CALL_ROUTE_NOT_FOUND');
        const route = saved.value as unknown as CallRoute, request = route.input.request;
        if (request.expectedSessionId !== query.sessionId || request.expectedBranch !== query.branchId
            || request.submission?.id !== query.callId || route.executionSessionId !== query.executionSessionId
            || query.executionSessionId === query.sessionId) throw failure('CALL_CONTROL_SCOPE_MISMATCH');
        const {receipt} = await this.observe(route);
        if (receipt.status !== 'accepted' || !receipt.execution) throw failure('CALL_EXECUTION_UNAVAILABLE');
        if (receipt.execution.role !== 'primary' || receipt.execution.taskId !== query.taskId) throw failure('CALL_CONTROL_SCOPE_MISMATCH');
        return (await this.executionTask(receipt))!;
    }
    private async executionTask(receipt: IndependentCallReceipt) {
        const execution = receipt.execution;
        if (!execution || !receipt.executionSessionId) return;
        const task = await this.options.kernel.task(receipt.executionSessionId, execution.taskId);
        if (task.id !== execution.taskId || task.sessionId !== receipt.executionSessionId
            || execution.invocation && task.labels?.invocationId && execution.invocation.invocationId !== task.labels.invocationId)
            throw failure('CALL_EXECUTION_CONFLICT');
        return task;
    }
    private async executionProjection(receipt: IndependentCallReceipt): Promise<Pick<IndependentCallView, 'executionState' | 'controlCapabilities' | 'interactions'>> {
        const task = await this.executionTask(receipt); if (!task) return {};
        const {id, revision, phase, control, blockedBy, activeOperations, settled, stopped} = taskStat(task);
        const executionState: IndependentCallExecutionState = {id, revision, phase, control, blockedBy, activeOperations, settled, stopped, controlEpoch: task.control?.epoch ?? 0};
        const flow = task.program.kind === 'flow.aggregate' || task.labels?.kind === 'flow-root';
        const supported = !flow || hasFlowControlTree(task);
        return {executionState, interactions: await readIndependentCallInteractions(this.options.kernel, task), controlCapabilities: {cancel: supported, respond: true, pause: supported ? 'boundary' : 'none', resume: supported, withdrawPause: supported}};
    }
    private async round(route: CallRoute): Promise<Round | undefined> {
        if (!route.executionSessionId) return;
        const raw = await this.options.repository.readDocument(route.executionSessionId, `round-${route.input.request.submission!.id}.json`);
        if (!raw) return;
        const round = JSON.parse(raw) as Round, submission = round.submission;
        if (round.sessionId !== route.executionSessionId || round.id !== route.input.request.submission!.id
            || submission?.source.kind !== 'independent-call' || submission.source.ownerId !== route.input.request.expectedSessionId
            || submission.id !== round.id || submission.source.id !== round.id) throw failure('CALL_EXECUTION_CONFLICT');
        return round;
    }
    private async readRoute(sessionId: string, id: string) {
        await this.options.repository.getManifest(sessionId);
        try {return await (await this.options.kernel.inspectSession(sessionId)).getShared(prefix + id);}
        catch (error) {if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return; throw error;}
    }
    private async identity(input: IndependentCallInput) {
        if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 4096
            || Object.keys(input).some(key => !['request', 'title', 'transfer'].includes(key))) throw failure('CALL_INPUT_INVALID');
        if (input.transfer && (Object.keys(input.transfer).some(key => !['sessionId', 'id'].includes(key))
            || typeof input.transfer.sessionId !== 'string' || typeof input.transfer.id !== 'string')) throw failure('CALL_INPUT_INVALID');
        const request = input.request, instruction = submissionInstruction(request);
        const sessionId = request.expectedSessionId, id = request.submission?.id;
        if (!sessionId || !id || !request.expectedBranch || !request.expectedTarget) throw failure('CALL_IDENTITY_REQUIRED');
        assertSubmissionBinding(request, sessionId);
        if (request.overrides?.baseRoundId || request.overrides?.newBranchName || request.overrides?.branchMode && request.overrides.branchMode !== 'continue')
            throw failure('CALL_CHILD_BRANCH_INVALID');
        const digest = await instructionDigest(prepareInstruction(instruction, sessionId, request.expectedBranch));
        return {sessionId, id, digest: await sha256Hex(JSON.stringify([digest, request.submission!.source.id, input.title, input.transfer?.sessionId, input.transfer?.id]))};
    }
    private async route(input: IndependentCallInput, digest: string): Promise<CallRoute> {
        const request = input.request, session = await this.options.kernel.openSession(request.expectedSessionId!);
        const key = prefix + request.submission!.id, stored = await session.getShared(key);
        if (stored) return this.match(stored.value, digest);
        const manifest = await this.options.repository.getManifest(request.expectedSessionId!);
        if (manifest.currentBranch !== request.expectedBranch) throw failure('CALL_BRANCH_CHANGED');
        const childRequest = await this.freezeRequest(request);
        const route: CallRoute = {input, digest, childRequest, createdAt: Date.now(), head: manifest.currentHead};
        await this.writable(request.expectedSessionId!);
        try {await session.setShared(key, json(route), {expectedVersion: null}); return route;}
        catch (error) {const observed = await session.getShared(key); if (!observed) throw error; return this.match(observed.value, digest);}
    }
    private async freezeRequest(request: SubmissionRequest): Promise<SubmissionRequest> {
        const instruction = submissionInstruction(request), caller = request.expectedSessionId!, id = request.submission!.id;
        const files = await new AttachmentProcessor(this.options.repository, this.host.logger).resolveAttachments(caller, instruction.text, instruction.files);
        const frozen = await freezeAttachments(this.options.repository, caller, id, files, this.host.logger);
        const names = new Map(files.map((file, index) => [file.name, frozen[index].name]));
        const text = instruction.text.replace(/@asset\/([^\s)"']+)/g, (ref, name: string) => names.has(name) ? `@asset/${names.get(name)}` : ref);
        return {...structuredClone(request), expectedBranch: 'main', attachments: frozen,
            source: request.source.kind === 'composer' ? {...request.source, text} : request.source,
            ...(request.presentation ? {presentation: {text}} : {}),
            submission: {id, source: {kind: 'independent-call', ownerId: caller, id}}};
    }
    private async bindRoute(route: CallRoute, sessionId: string): Promise<CallRoute> {
        if (route.executionSessionId && route.executionSessionId !== sessionId) throw failure('CALL_ROUTE_CONFLICT');
        const caller = route.input.request.expectedSessionId!, key = prefix + route.input.request.submission!.id;
        const session = await this.options.kernel.openSession(caller), stored = (await session.getShared(key))!;
        const current = this.match(stored.value, route.digest);
        if (current.executionSessionId) {if (current.executionSessionId !== sessionId) throw failure('CALL_ROUTE_CONFLICT'); return current;}
        const bound = {...current, executionSessionId: sessionId, childRequest: {...current.childRequest, expectedSessionId: sessionId}};
        await this.writable(caller);
        try {await session.setShared(key, json(bound), {expectedVersion: stored.version}); return bound;}
        catch (error) {
            const observed = await session.getShared(key);
            if (!observed) throw error;
            const found = this.match(observed.value, route.digest);
            if (found.executionSessionId !== sessionId) throw error;
            return found;
        }
    }
    private async copyAttachments(route: CallRoute): Promise<void> {
        await this.writable(route.executionSessionId!);
        const files = [];
        for (const file of route.childRequest.attachments ?? []) {
            const fileRef = await readVerifiedAttachment(this.options.repository, route.input.request.expectedSessionId!, file);
            files.push({...file, fileRef});
        }
        await freezeAttachments(this.options.repository, route.executionSessionId!, route.childRequest.submission!.id, files, this.host.logger);
    }
    private async receipt(route: CallRoute): Promise<IndependentCallReceipt> {return (await this.observe(route)).receipt;}
    private async observe(route: CallRoute): Promise<{receipt: IndependentCallReceipt; round?: Round}> {
        const request = route.input.request, base = {operationId: request.submission!.id, callerSessionId: request.expectedSessionId!, executionSessionId: route.executionSessionId};
        if (!route.executionSessionId) return {receipt: {...base, status: 'unknown'}};
        const receipt = await readSubmissionReceipt(this.options.kernel, this.options.repository, route.executionSessionId, submissionInstruction(route.childRequest));
        const round = receipt.status === 'accepted' ? await this.round(route) : undefined;
        return {receipt: {...base, ...receipt, ...(round ? {execution: round.executions.find(execution => execution.role === 'primary')} : {})}, round};
    }
    private match(value: JsonValue, digest: string): CallRoute {
        const route = value as unknown as CallRoute;
        if (route.digest !== digest) throw failure('CALL_REQUEST_CONFLICT');
        return structuredClone(route);
    }
    private async writable(id: string): Promise<void> {if (this.options.canWrite && !await this.options.canWrite(id)) throw failure('CALL_READ_ONLY');}
}
function json(value: unknown): JsonValue {return JSON.parse(JSON.stringify(value));}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}

function outputSummary(round: Round): string {
    if (!['completed', 'failed', 'cancelled'].includes(round.status)) return '';
    return round.output.map(message => typeof message.content === 'string' ? message.content
        : message.content.filter(part => part.type === 'text').map(part => 'text' in part ? part.text : '').join('\n')).join('\n\n').slice(0, 2000);
}
