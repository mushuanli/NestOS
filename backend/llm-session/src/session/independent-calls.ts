import {submitPreparedTaskCall, readTaskCallSubmission, readTaskCallExecution} from '@itookit/llm-flow';
import {snapshotIndependentTaskCallPolicy, newIndependentKernelPreparation, assertIndependentPreparationMode, freezeIndependentTaskCall, readIndependentTaskCall, independentPreparationError, type IndependentKernelPreparation, type IndependentTaskCallPolicy, type IndependentTaskCallPreparation, type PreparedIndependentTaskCall, type IndependentTaskCallAdmission, type PreparationScope} from './independent-call-preparation';
import {committedIndependentKernelHistory} from './independent-call-history';
import {independentCallResult} from './independent-call-result';
import {RoundLog} from '../persistence/round-log';
import {IndependentCallDescendants} from './independent-call-descendants';
import {independentCallTaskState, supportsCallCancellation} from './independent-call-task-state';
import {readIndependentCallTree} from './independent-call-tree';
import {IndependentCallResponses} from './independent-call-responses';
import {IndependentCallControls} from './independent-call-controls';
import {KernelError, KernelErrorCode, type Kernel, type JsonValue} from '@itookit/durable-kernel';
import {sha256Hex} from '@itookit/llm-context';
import {IndependentCallCommand, type IndependentCallExecutionQuery, type IndependentCallInput, type IndependentCallView, type IndependentCallListQuery, type IndependentCallReceipt, type IndependentCallSubmitter} from '../contracts/independent-calls';
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

interface CallRoute {createdAt?: number; head?: string | null; digest: string; input: IndependentCallInput; childRequest: SubmissionRequest; executionSessionId?: string; kernelPreparation?: IndependentKernelPreparation}
interface Options {
    kernel: Kernel; repository: ISessionRepository; transfers: Pick<ContentTransferService, 'createChild'>;
    submit: IndependentCallSubmitter; prepareExecution?(sessionId: string): Promise<void>; canWrite?(sessionId: string): Promise<boolean>; hostPorts?: SessionHostPorts;
    prepareTaskCall?: IndependentTaskCallPreparation['prepare'];
    taskCallPolicy?(request: SubmissionRequest): Promise<IndependentTaskCallPolicy | undefined>;
}
interface ObservedCall {receipt: IndependentCallReceipt; round?: Round; callerState?: import('../contracts/independent-calls').IndependentCallExecutionState; historyPending?: boolean}
const prefix = 'conversation/call/';
interface PreparationProgress {stage: string; executionSessionId?: string}
/** Trusted Effect admission only; a held attempt says nothing about an earlier submission. */
export type ManagedCallAdmission = IndependentCallReceipt | (Omit<IndependentCallReceipt, 'status' | 'evidence' | 'execution'> & {status: 'held'});
export type ManagedCallAdmissionGuard = (request: SubmissionRequest) => Promise<boolean>;
/** Session routes and projections reuse queue/history or Kernel facts; they never own another executor. */
export class IndependentCallService {
    private readonly host;
    private historyEnabled = false;
    private readonly stopping = new AbortController();
    private readonly observers = new Map<string, Promise<void>>();
    private readonly historyListeners = new Set<(sessionId: string) => Promise<void>>();
    constructor(private readonly options: Options) {this.host = createSessionHost(options.hostPorts);}
    register(commands: ICommandBus): void {
        this.historyEnabled = true;
        commands.register(IndependentCallCommand.Submit, value => this.submit(value as IndependentCallInput));
        commands.register(IndependentCallCommand.Inspect, value => this.inspect(value as IndependentCallInput));
        commands.register(IndependentCallCommand.List, value => this.list(value as IndependentCallListQuery));
        new IndependentCallDescendants(this.options.kernel, this.host.logger, query => this.controlTarget(query)).register(commands);
        new IndependentCallControls({kernel: this.options.kernel, commands, logger: this.host.logger,
            canWrite: this.options.canWrite, resolve: query => this.controlTarget(query)}).register();
        new IndependentCallResponses({kernel: this.options.kernel, commands, logger: this.host.logger,
            canWrite: this.options.canWrite, resolve: query => this.controlTarget(query)}).register();
    }
    async submit(supplied: IndependentCallInput): Promise<IndependentCallReceipt> {
        const input = structuredClone(supplied);
        return this.tracePreparation(input, 'call.submit', async progress => {
            const identity = await this.identity(input); progress.stage = 'route';
            const saved = await this.readRoute(identity.sessionId, identity.id);
            const route = saved && this.match(saved.value, identity.digest);
            progress.stage = 'policy';
            const policy = route ? route.kernelPreparation?.policy : await this.options.taskCallPolicy?.(input.request);
            if (!policy) {progress.stage = 'legacy-queue'; return this.submitWithGuard(input);}
            progress.stage = 'prepare'; await this.prepareTaskCall(input, policy);
            progress.stage = 'kernel-submit';
            try {await this.submitPreparedTaskCall(input);}
            catch (error) {
                progress.stage = 'reconcile-admission';
                if (!(await this.inspectTaskCallSubmission(input))) throw error;
                this.observeHistory(input);
            }
            progress.stage = 'receipt'; return this.inspect(input);
        });
    }
    /** Not an RPC argument: the owner must persist its fenced dispatch intent before returning true. */
    submitManaged(supplied: IndependentCallInput, guard: ManagedCallAdmissionGuard): Promise<ManagedCallAdmission> {
        if (typeof guard !== 'function') return Promise.reject(failure('CALL_ADMISSION_GUARD_REQUIRED'));
        return this.submitWithGuard(supplied, guard);
    }
    private submitWithGuard(supplied: IndependentCallInput): Promise<IndependentCallReceipt>;
    private submitWithGuard(supplied: IndependentCallInput, guard: ManagedCallAdmissionGuard): Promise<ManagedCallAdmission>;
    private async submitWithGuard(supplied: IndependentCallInput, guard?: ManagedCallAdmissionGuard): Promise<ManagedCallAdmission> {
        const input = structuredClone(supplied), started = Date.now(), progress = {stage: 'validate'};
        let outcome = 'failure', code: string | undefined;
        const suppliedId = input?.request?.submission?.id;
        const operationId = typeof suppliedId === 'string' && /^[\w-]{1,128}$/.test(suppliedId) ? suppliedId : undefined;
        try {
            const identity = await this.identity(input); progress.stage = 'route';
            await this.options.repository.getManifest(identity.sessionId);
            await this.options.prepareExecution?.(identity.sessionId);
            await this.writable(identity.sessionId);
            let route = await this.route(input, identity.digest);
            const child = await this.options.transfers.createChild({sessionId: identity.sessionId,
                requestId: `call-${await sha256Hex(identity.id)}`, title: input.title, transfer: input.transfer});
            route = await this.bindRoute(route, child.sessionId);
            const result = await this.admit(route, progress, guard); outcome = result.status; return result;
        } catch (error) {
            const suppliedCode = (error as {code?: unknown})?.code;
            code = typeof suppliedCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(suppliedCode) ? suppliedCode : 'CALL_INDEPENDENT_FAILED';
            throw error;
        } finally {
            const detail = {operation: 'call.independent', operationId, stage: progress.stage, outcome, code, durationMs: Date.now() - started};
            try {
                if (outcome === 'failure') this.host.logger.warn('Independent call observation', detail);
                else this.host.logger.info('Independent call observation', detail);
            } catch { /* Diagnostics cannot replace admission or the original failure. */ }
        }
    }
    async prepareTaskCall(supplied: IndependentCallInput, options: IndependentTaskCallPreparation | IndependentTaskCallPolicy): Promise<PreparedIndependentTaskCall> {
        const input = structuredClone(supplied), prepare = options && typeof options === 'object' && 'prepare' in options ? options.prepare : this.options.prepareTaskCall;
        return this.tracePreparation(input, 'call.prepare', async progress => {
            const policy = snapshotIndependentTaskCallPolicy(options);
            if (typeof prepare !== 'function') throw independentPreparationError('CALL_PREPARATION_UNAVAILABLE');
            return this.prepareCallRoute(input, policy, prepare, progress);
        });
    }
    private async prepareCallRoute(input: IndependentCallInput, policy: IndependentTaskCallPolicy,
        prepare: IndependentTaskCallPreparation['prepare'], progress: PreparationProgress): Promise<PreparedIndependentTaskCall> {
        const identity = await this.identity(input);
        if (input.request.expectedTarget?.kind !== 'agent') throw independentPreparationError('CALL_GRAPH_PREPARATION_REQUIRED');
        await this.options.repository.getManifest(identity.sessionId);
        await this.options.prepareExecution?.(identity.sessionId); await this.writable(identity.sessionId);
        progress.stage = 'route'; let route = await this.route(input, identity.digest, policy);
        if (!route.executionSessionId) {
            const child = await this.options.transfers.createChild({sessionId: identity.sessionId,
                requestId: `call-${await sha256Hex(identity.id)}`, title: input.title, transfer: input.transfer});
            route = await this.bindRoute(route, child.sessionId);
        }
        this.assertPreparationRoute(route, identity);
        progress.executionSessionId = route.executionSessionId;
        await this.writable(route.executionSessionId!);
        const previous = this.preparedCall(route); if (previous) return previous;
        progress.stage = 'attachments'; await this.copyAttachments(route);
        progress.stage = 'prepare';
        const ready = await prepare(structuredClone(route.childRequest), structuredClone(route.kernelPreparation!.invocation));
        const data = freezeIndependentTaskCall(route.kernelPreparation!, this.preparationScope(route), ready);
        progress.stage = 'persist'; route = await this.savePreparation(route, data);
        return this.preparedCall(route)!;
    }
    async inspectPreparedTaskCall(supplied: IndependentCallInput): Promise<PreparedIndependentTaskCall | undefined> {
        const input = structuredClone(supplied);
        return this.tracePreparation(input, 'call.prepare.inspect', async progress => {
            const identity = await this.identity(input); progress.stage = 'lookup';
            const stored = await this.readRoute(identity.sessionId, identity.id); progress.stage = 'plan';
            const route = stored && this.match(stored.value, identity.digest);
            if (route) this.assertPreparationRoute(route, identity);
            const ready = route && this.preparedCall(route);
            progress.executionSessionId = ready?.executionSessionId; return ready;
        });
    }
    /** Trusted host dispatch of an already frozen route; never uses the legacy queue submitter. */
    async submitPreparedTaskCall(supplied: IndependentCallInput): Promise<IndependentTaskCallAdmission> {
        const input = structuredClone(supplied);
        return this.tracePreparation(input, 'call.submit.prepared', async progress => {
            const ready = await this.requirePreparedTaskCall(input); progress.executionSessionId = ready.executionSessionId;
            await this.writable(ready.caller.sessionId); await this.writable(ready.executionSessionId);
            progress.stage = 'caller';
            const run = await submitPreparedTaskCall(ready.plan, {kernel: this.options.kernel, caller: ready.caller,
                onDiagnostic: event => this.host.logger.debug('Prepared Kernel call', event)});
            progress.stage = 'receipt'; const observed = await this.taskCallAdmission(ready);
            if (!observed || observed.submission.task.taskId !== run.root.id) throw independentPreparationError('CALL_EXECUTION_CONFLICT');
            this.observeHistory(input);
            return observed;
        });
    }
    /** Reattach only admitted calls; a prepared but unsubmitted route is not dispatch permission. */
    async recover(): Promise<void> {
        this.historyEnabled = true;
        for await (const session of this.options.kernel.listSessions()) {
            if (this.stopping.signal.aborted) return;
            await this.recoverSessionHistory(session.id);
        }
    }
    private async recoverSessionHistory(sessionId: string): Promise<void> {
        const started = Date.now();
        try {
            const entries = await this.options.kernel.listShared(sessionId, prefix);
            for (const entry of entries) {
                const route = entry.value as unknown as CallRoute;
                if (route.kernelPreparation && route.input?.request.expectedSessionId === sessionId) this.observeHistory(route.input);
            }
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            try {this.host.logger.warn('Independent call recovery scan failed', {operation: 'call.history.recover', stage: 'scan',
                sessionId: /^[\w:-]{1,256}$/.test(sessionId) ? sessionId : undefined, outcome: 'failure', durationMs: Date.now() - started,
                errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_RECOVERY_SCAN_FAILED'});}
            catch { /* Diagnostics cannot prevent recovery of other Sessions. */ }
        }
    }
    async dispose(): Promise<void> {
        this.stopping.abort(); await Promise.allSettled(this.observers.values()); this.historyListeners.clear();
    }
    onHistoryCommitted(listener: (sessionId: string) => Promise<void>): () => void {
        this.historyListeners.add(listener); return () => {this.historyListeners.delete(listener);};
    }
    private async publishHistory(sessionId: string): Promise<void> {
        await Promise.allSettled([...this.historyListeners].map(listener => Promise.resolve().then(() => listener(sessionId))));
    }
    private observeHistory(input: IndependentCallInput): void {
        if (!this.historyEnabled || this.stopping.signal.aborted) return;
        const key = JSON.stringify([input.request.expectedSessionId, input.request.submission!.id]);
        if (this.observers.has(key)) return;
        const work = Promise.resolve().then(() => this.followHistory(structuredClone(input)))
            .catch(() => { /* tracePreparation records the stage and safe error code; restart retries the same route. */ })
            .finally(() => {this.observers.delete(key);});
        this.observers.set(key, work);
    }
    private async followHistory(input: IndependentCallInput): Promise<void> {
        await this.tracePreparation(input, 'call.history.recover', async progress => {
            progress.stage = 'receipt'; const admitted = await this.inspectTaskCallSubmission(input);
            if (!admitted || this.stopping.signal.aborted) return;
            progress.executionSessionId = admitted.executionSessionId;
            await this.writable(admitted.submission.task.sessionId); await this.writable(admitted.executionSessionId);
            progress.stage = 'resume-admitted';
            await this.submitPreparedTaskCall(input);
            const ref = admitted.submission.task, caller = await this.options.kernel.attachTask(ref.sessionId, ref.taskId);
            progress.stage = 'wait'; await caller.wait({until: 'settled', signal: this.stopping.signal});
            if (this.stopping.signal.aborted) return;
            progress.stage = 'history'; await this.reconcileTaskCallHistory(input);
        });
    }
    async inspectTaskCallSubmission(supplied: IndependentCallInput): Promise<IndependentTaskCallAdmission | undefined> {
        const input = structuredClone(supplied);
        return this.tracePreparation(input, 'call.submit.inspect', async progress => {
            const ready = await this.inspectPreparedTaskCall(input); if (!ready) return;
            progress.executionSessionId = ready.executionSessionId; progress.stage = 'receipt'; return this.taskCallAdmission(ready);
        });
    }
    /** Repair history from existing Kernel facts; never submit, bind, or restart execution. */
    async reconcileTaskCallHistory(supplied: IndependentCallInput): Promise<boolean> {
        const input = structuredClone(supplied);
        return this.tracePreparation(input, 'call.history.reconcile', async progress => {
            const identity = await this.identity(input); progress.stage = 'route';
            const stored = await this.readRoute(identity.sessionId, identity.id);
            if (!stored) return false;
            const route = this.match(stored.value, identity.digest), ready = this.preparedCall(route);
            if (!ready) return false;
            this.assertPreparationRoute(route, identity); progress.executionSessionId = ready.executionSessionId;
            progress.stage = 'target'; const observed = await this.taskCallExecution(ready);
            if (!observed?.target) {progress.stage = 'target-unavailable'; return false;}
            const committed = await committedIndependentKernelHistory(this.options.repository, route.childRequest,
                ready.invocation, observed.target, await this.round(route));
            if (committed) return true;
            const task = await this.options.kernel.task(observed.target.sessionId, observed.target.taskId);
            progress.stage = 'result'; const round = await independentCallResult(route.childRequest, ready, task);
            if (!round) {progress.stage = 'target-unsettled'; return false;}
            progress.stage = 'history';
            await this.writable(identity.sessionId); await this.writable(ready.executionSessionId);
            await new RoundLog(this.options.repository, ready.executionSessionId).commitExpected(route.childRequest.expectedBranch!, round, null);
            progress.stage = 'publish-history'; await this.publishHistory(ready.executionSessionId);
            return true;
        });
    }
    private async taskCallExecution(ready: PreparedIndependentTaskCall) {
        const observed = await readTaskCallExecution(ready.plan, {kernel: this.options.kernel, caller: ready.caller,
            onDiagnostic: event => this.host.logger.debug('Prepared Kernel execution', event)});
        return observed && {...callAdmission(ready, observed.submission), ...(observed.target ? {target: observed.target} : {})};
    }
    private async requirePreparedTaskCall(input: IndependentCallInput): Promise<PreparedIndependentTaskCall> {
        const ready = await this.inspectPreparedTaskCall(input);
        if (!ready) throw independentPreparationError('CALL_PREPARATION_REQUIRED'); return ready;
    }
    private async taskCallAdmission(ready: PreparedIndependentTaskCall): Promise<IndependentTaskCallAdmission | undefined> {
        const submission = await readTaskCallSubmission(ready.plan, {kernel: this.options.kernel, caller: ready.caller,
            onDiagnostic: event => this.host.logger.debug('Prepared Kernel call receipt', event)});
        return submission && callAdmission(ready, submission);
    }
    private async tracePreparation<T>(input: IndependentCallInput, operation: string, work: (progress: PreparationProgress) => Promise<T>): Promise<T> {
        const started = Date.now(), progress: PreparationProgress = {stage: 'validate'}, supplied = input?.request?.submission?.id;
        const source = input?.request?.expectedSessionId, sessionId = typeof source === 'string' && /^[\w:-]{1,256}$/.test(source) ? source : undefined;
        const operationId = typeof supplied === 'string' && /^[\w-]{1,128}$/.test(supplied) ? supplied : undefined;
        let errorCode: string | undefined;
        try {return await work(progress);}
        catch (error) {const code = (error as {code?: unknown})?.code;
            errorCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CALL_PREPARATION_FAILED'; throw error;}
        finally {const child = progress.executionSessionId, executionSessionId = typeof child === 'string' && /^[\w:-]{1,256}$/.test(child) ? child : undefined;
            const detail = {operation, stage: progress.stage, outcome: errorCode ? 'failure' : 'success', errorCode, operationId, sessionId, executionSessionId, durationMs: Date.now() - started};
            try {if (errorCode) this.host.logger.warn('Independent call preparation', detail); else this.host.logger.info('Independent call preparation', detail);}
            catch { /* Diagnostics cannot change the persisted plan or the original failure. */ }}
    }
    private preparationScope(route: CallRoute): PreparationScope {
        return {operationId: route.input.request.submission!.id, sessionId: route.executionSessionId!, roundId: route.childRequest.submission!.id,
            target: route.childRequest.expectedTarget!, branch: route.childRequest.expectedBranch!};
    }
    private preparedCall(route: CallRoute): PreparedIndependentTaskCall | undefined {
        if (!route.kernelPreparation) return;
        const data = readIndependentTaskCall(route.kernelPreparation, this.preparationScope(route)); if (!data) return;
        return {operationId: route.input.request.submission!.id,
            caller: {sessionId: route.input.request.expectedSessionId!, requestId: route.kernelPreparation.callerRequestId}, executionSessionId: route.executionSessionId!, invocation: structuredClone(route.kernelPreparation.invocation), ...data};
    }
    private async savePreparation(route: CallRoute, prepared: NonNullable<IndependentKernelPreparation['prepared']>): Promise<CallRoute> {
        const caller = route.input.request.expectedSessionId!, session = await this.options.kernel.openSession(caller);
        const key = prefix + route.input.request.submission!.id, stored = (await session.getShared(key))!;
        const current = this.match(stored.value, route.digest);
        this.assertPreparationOwner(current, route);
        if (this.preparedCall(current)) return current;
        const next = {...current, kernelPreparation: {...current.kernelPreparation!, prepared}};
        await this.writable(caller); await this.writable(next.executionSessionId!);
        try {await session.setShared(key, json(next), {expectedVersion: stored.version}); return next;}
        catch (error) {const observed = await session.getShared(key); if (!observed) throw error;
            const found = this.match(observed.value, route.digest);
            this.assertPreparationOwner(found, route);
            if (!this.preparedCall(found)) throw error; return found;}
    }
    private assertPreparationOwner(current: CallRoute, expected: CallRoute): void {
        assertIndependentPreparationMode(current.kernelPreparation, expected.kernelPreparation?.policy);
        this.assertPreparationRoute(current, {sessionId: expected.input.request.expectedSessionId!, id: expected.input.request.submission!.id});
        if (current.kernelPreparation!.callerRequestId !== expected.kernelPreparation!.callerRequestId || current.executionSessionId !== expected.executionSessionId
            || JSON.stringify(current.kernelPreparation!.invocation) !== JSON.stringify(expected.kernelPreparation!.invocation))
            throw independentPreparationError('CALL_PREPARATION_SCOPE_MISMATCH');
    }
    private assertPreparationRoute(route: CallRoute, expected: {sessionId: string; id: string}): void {
        if (route.input?.request?.expectedSessionId !== expected.sessionId || route.input.request.submission?.id !== expected.id)
            throw independentPreparationError('CALL_PREPARATION_SCOPE_MISMATCH');
    }
    private async admit(route: CallRoute, progress: {stage: string}, guard?: ManagedCallAdmissionGuard): Promise<ManagedCallAdmission> {
        progress.stage = 'receipt';
        const previous = await this.receipt(route);
        if (previous.status === 'accepted') return previous;
        progress.stage = 'attachments';
        await this.copyAttachments(route);
        const request = structuredClone(route.childRequest);
        progress.stage = 'admission-guard';
        if (guard && await guard(structuredClone(request)) !== true) {
            progress.stage = 'receipt'; return this.heldAdmission(route);
        }
        progress.stage = 'dispatch';
        try {
            const accepted = await this.options.submit(request);
            if (accepted !== route.input.request.submission!.id) throw failure('CALL_RECEIPT_MISMATCH');
        } catch (error) {
            progress.stage = 'receipt';
            const observed = await this.receipt(route);
            if (observed.status !== 'accepted') throw error;
        }
        progress.stage = 'receipt';
        return this.receipt(route);
    }
    private async heldAdmission(route: CallRoute): Promise<ManagedCallAdmission> {
        const observed = await this.receipt(route);
        if (observed.status === 'accepted') return observed;
        return {operationId: observed.operationId, callerSessionId: observed.callerSessionId,
            executionSessionId: observed.executionSessionId, status: 'held'};
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
            const {receipt, round, ...observation} = await this.observe(route);
            const executionView = await this.executionProjection(receipt);
            views.push({input: structuredClone(route.input), receipt, createdAt: route.createdAt ?? 0, head: route.head ?? null, ...observation, ...executionView,
                ...(round ? {status: round.status, summary: outputSummary(round)} : {})});
        }
        return views.sort((a, b) => a.createdAt - b.createdAt || a.receipt.operationId.localeCompare(b.receipt.operationId));
    }
    private async controlTarget(query: IndependentCallExecutionQuery) {
        const saved = await this.readRoute(query.sessionId, query.callId);
        if (!saved) throw failure('CALL_ROUTE_NOT_FOUND');
        const route = saved.value as unknown as CallRoute, request = route.input.request;
        if (request.expectedSessionId !== query.sessionId || request.expectedBranch !== query.branchId
            || request.submission?.id !== query.callId || route.executionSessionId !== query.executionSessionId
            || query.executionSessionId === query.sessionId) throw failure('CALL_CONTROL_SCOPE_MISMATCH');
        const receipt = route.kernelPreparation ? await this.kernelExecutionReceipt(route) : (await this.observe(route)).receipt;
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
    private async executionProjection(receipt: IndependentCallReceipt): Promise<Pick<IndependentCallView, 'executionState' | 'executionTree' | 'controlCapabilities' | 'interactions' | 'descendants'>> {
        const expected = await this.executionTask(receipt); if (!expected) return {};
        const {task, tree: executionTree, interactions, descendants} = await this.readExecutionTree(receipt, expected);
        const executionState = independentCallTaskState(task), supported = supportsCallCancellation(task);
        return {executionState, executionTree, interactions, descendants, controlCapabilities: {cancel: supported, cancelRemaining: supported, respond: true, pause: supported ? 'boundary' : 'none', resume: supported, withdrawPause: supported}};
    }
    private async readExecutionTree(receipt: IndependentCallReceipt, expected: import('@itookit/durable-kernel').TaskRecord) {
        const started = Date.now(); let outcome = 'failure', code: string | undefined, tasks: number | undefined;
        try {const result = await readIndependentCallTree(this.options.kernel, expected); outcome = 'observed'; tasks = result.tree.tasks; return result;}
        catch (error) {const supplied = (error as {code?: unknown})?.code;
            code = typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(supplied) ? supplied : 'CALL_EXECUTION_TREE_READ_FAILED'; throw error;}
        finally {
            const safe = (value: string) => /^[\w:-]{1,256}$/.test(value) ? value : undefined;
            const detail = {operation: 'call.list', operationId: safe(receipt.operationId), taskId: safe(expected.id), stage: 'execution-tree', outcome, code, tasks, durationMs: Date.now() - started};
            try {if (code) this.host.logger.warn('Independent execution tree', detail); else this.host.logger.debug('Independent execution tree', detail);}
            catch { /* Observation diagnostics never alter execution facts. */ }
        }
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
    private async route(input: IndependentCallInput, digest: string, policy?: IndependentTaskCallPolicy): Promise<CallRoute> {
        const request = input.request, session = await this.options.kernel.openSession(request.expectedSessionId!);
        const key = prefix + request.submission!.id, stored = await session.getShared(key);
        if (stored) return this.routeMode(this.match(stored.value, digest), policy);
        const manifest = await this.options.repository.getManifest(request.expectedSessionId!);
        if (manifest.currentBranch !== request.expectedBranch) throw failure('CALL_BRANCH_CHANGED');
        const childRequest = await this.freezeRequest(request);
        const route: CallRoute = {input, digest, childRequest, createdAt: Date.now(), head: manifest.currentHead,
            ...(policy ? {kernelPreparation: newIndependentKernelPreparation(policy, request.submission!.id)} : {})};
        await this.writable(request.expectedSessionId!);
        try {await session.setShared(key, json(route), {expectedVersion: null}); return route;}
        catch (error) {const observed = await session.getShared(key); if (!observed) throw error; return this.routeMode(this.match(observed.value, digest), policy);}
    }
    private routeMode(route: CallRoute, policy?: IndependentTaskCallPolicy): CallRoute {
        assertIndependentPreparationMode(route.kernelPreparation, policy); return route;
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
        if (!route.kernelPreparation) return (await this.observe(route)).receipt;
        return this.tracePreparation(route.input, 'call.receipt.inspect', async progress => {
            progress.stage = 'plan'; const ready = this.preparedCall(route); progress.executionSessionId = ready?.executionSessionId;
            progress.stage = 'receipt'; const admitted = ready && await this.taskCallAdmission(ready);
            return admitted ? kernelReceipt(route, admitted) : {...callReceiptBase(route), status: 'unknown'};
        });
    }
    /** Control authority comes from the owning Kernel relation, never history availability. */
    private async kernelExecutionReceipt(route: CallRoute): Promise<IndependentCallReceipt> {
        const ready = this.preparedCall(route), observed = ready && await this.taskCallExecution(ready);
        return observed ? kernelReceipt(route, observed, observed.target) : {...callReceiptBase(route), status: 'unknown'};
    }
    private async observe(route: CallRoute): Promise<ObservedCall> {
        const base = callReceiptBase(route);
        if (!route.executionSessionId) return {receipt: {...base, status: 'unknown'}};
        if (route.kernelPreparation) return this.observeKernelCall(route, base);
        const receipt = await readSubmissionReceipt(this.options.kernel, this.options.repository, route.executionSessionId, submissionInstruction(route.childRequest));
        const round = receipt.status === 'accepted' ? await this.round(route) : undefined;
        return {receipt: {...base, ...receipt, ...(round ? {execution: round.executions.find(execution => execution.role === 'primary')} : {})}, round};
    }
    private async observeKernelCall(route: CallRoute, base: Pick<IndependentCallReceipt, 'operationId' | 'callerSessionId' | 'executionSessionId'>): Promise<ObservedCall> {
        return this.tracePreparation(route.input, 'call.execution.observe', async progress => {
            progress.stage = 'plan';
            this.assertPreparationRoute(route, {sessionId: base.callerSessionId, id: base.operationId});
            const ready = this.preparedCall(route); progress.executionSessionId = ready?.executionSessionId; progress.stage = 'target';
            const observed = ready && await this.taskCallExecution(ready);
            if (!observed) return {receipt: {...base, status: 'unknown'}};
            progress.stage = 'caller';
            const ref = observed.submission.task, caller = await this.options.kernel.task(ref.sessionId, ref.taskId);
            if (caller.id !== ref.taskId || caller.sessionId !== ref.sessionId) throw failure('CALL_EXECUTION_CONFLICT');
            progress.stage = 'history'; const round = await committedIndependentKernelHistory(this.options.repository, route.childRequest,
                ready!.invocation, observed.target, await this.round(route));
            return {receipt: kernelReceipt(route, observed, observed.target),
                round, callerState: independentCallTaskState(caller), historyPending: !round};
        });
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

function callAdmission(ready: PreparedIndependentTaskCall, submission: import('@itookit/durable-kernel').TaskSubmissionReceipt): IndependentTaskCallAdmission {
    return {operationId: ready.operationId, invocation: structuredClone(ready.invocation), executionSessionId: ready.executionSessionId, submission};
}

function callReceiptBase(route: CallRoute) {
    return {operationId: route.input.request.submission!.id, callerSessionId: route.input.request.expectedSessionId!, executionSessionId: route.executionSessionId};
}
function kernelReceipt(route: CallRoute, admitted: IndependentTaskCallAdmission, target?: import('@itookit/durable-kernel').TaskRef): IndependentCallReceipt {
    return {...callReceiptBase(route), status: 'accepted', evidence: 'kernel', callerExecution: admitted.submission.task,
        ...(target ? {execution: {taskId: target.taskId, role: 'primary', invocation: structuredClone(admitted.invocation)}} : {})};
}
