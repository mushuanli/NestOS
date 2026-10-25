import {KernelError, KernelErrorCode, type Kernel, type JsonValue} from '@itookit/durable-kernel';
import {sha256Hex} from '@itookit/llm-context';
import {IndependentCallCommand, type IndependentCallInput, type IndependentCallReceipt, type IndependentCallSubmitter} from '../contracts/independent-calls';
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

interface CallRoute {digest: string; input: IndependentCallInput; childRequest: SubmissionRequest; executionSessionId?: string}
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
        const route: CallRoute = {input, digest, childRequest};
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
    private async receipt(route: CallRoute): Promise<IndependentCallReceipt> {
        const request = route.input.request, base = {operationId: request.submission!.id, callerSessionId: request.expectedSessionId!, executionSessionId: route.executionSessionId};
        if (!route.executionSessionId) return {...base, status: 'unknown'};
        const receipt = await readSubmissionReceipt(this.options.kernel, this.options.repository, route.executionSessionId, submissionInstruction(route.childRequest));
        const raw = receipt.status === 'accepted' && await this.options.repository.readDocument(route.executionSessionId, `round-${base.operationId}.json`);
        const round = raw ? JSON.parse(raw) as Round : undefined;
        return {...base, ...receipt, ...(round?.sessionId === route.executionSessionId && round.submission?.source.ownerId === base.callerSessionId
            ? {execution: round.executions[0]} : {})};
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
