import {sha256HexSync} from '@itookit/common';
import {assertHarnessContextRequest} from '@itookit/kernel-adapters/contracts';
import type {EffectSessionState} from '@itookit/durable-kernel';
import type {ContextBinding, ContextBindingOperation, HarnessConnectionSnapshot, HarnessContextRequest,
    NativeContextRef, ContextCheckpoint} from '@itookit/kernel-adapters/contracts';
import {canonical} from './harness-connection-policy';
import {executionError, jsonValue} from './harness-execution-journal';

export const CONTEXT_BINDINGS_KEY = 'harness.context.bindings';
interface BindingCollection {version: 1; sessionId: string; bindings: Record<string, ContextBinding>}
type Selection = HarnessContextRequest['conversation'];

/** Context metadata uses the existing fenced Session shared state, never a second execution status. */
export class HarnessContextBindings {
    constructor(private readonly state: EffectSessionState, private readonly sessionId: string) {}

    async list(): Promise<ContextBinding[]> {return Object.values((await this.read()).value.bindings);}
    async get(id: string): Promise<ContextBinding | undefined> {
        const bindings = (await this.read()).value.bindings;
        return Object.hasOwn(bindings, id) ? bindings[id] : undefined;
    }

    async claim(id: string, context: HarnessContextRequest, connection: HarnessConnectionSnapshot,
        operation: ContextBindingOperation): Promise<ContextBinding> {
        assertHarnessContextRequest(context);
        if (!validOperation(operation)) throw executionError('CONTEXT_OPERATION_INVALID');
        operation = operationSnapshot(operation);
        if (operation.invocationId !== context.invocationId) throw executionError('CONTEXT_INVOCATION_CONFLICT');
        return this.update(id, (current, collection) => {
            if (sameOperation(current?.activeOperation, operation) || sameOperation(current?.lastOperation, operation)) {
                assertCompatible(current!, context, connection); return current!;
            }
            if (context.conversation.mode === 'continue') return continueBinding(current, context, connection, operation);
            if (current) throw executionError('CONTEXT_BINDING_CONFLICT');
            if (context.conversation.mode === 'fork') return forkBinding(id, this.sessionId, collection, context, connection, operation);
            return newBinding(id, this.sessionId, context, connection, operation);
        });
    }

    async attach(id: string, operationId: string, nativeRef: NativeContextRef, invalidReason?: string): Promise<ContextBinding> {
        return this.update(id, (current, collection) => {
            requireOwner(current, operationId);
            if (!validNativeRef(nativeRef)) throw executionError('CONTEXT_NATIVE_REFERENCE_INVALID');
            if (current.nativeRef && canonical(current.nativeRef) !== canonical(nativeRef)) throw executionError('CONTEXT_NATIVE_REFERENCE_CONFLICT');
            if (Object.values(collection.bindings).some(other => other.id !== id && other.nativeRef
                && nativeThreadKey(other.nativeRef) === nativeThreadKey(nativeRef))) throw executionError('CONTEXT_NATIVE_ALIAS_CONFLICT');
            const {nodeConnectionId, profileId, workspaceId, sessionId, epoch} = nativeRef;
            if (invalidReason !== undefined && !/^[A-Z][A-Z0-9_]{0,79}$/.test(invalidReason)) throw executionError('CONTEXT_INVALID_REASON');
            return {...current, nativeRef: {nodeConnectionId, profileId, workspaceId, sessionId, epoch},
                validity: invalidReason ? 'invalid' : 'valid', ...(invalidReason ? {invalidReason} : {})};
        });
    }

    async prepareSettlement(id: string, operationId: string, settlement: NonNullable<ContextBinding['settlement']>): Promise<ContextBinding> {
        return this.update(id, current => {
            requireOwner(current, operationId);
            if (settlement.operationId !== operationId) throw executionError('CONTEXT_OPERATION_CONFLICT');
            if (settlement.kind === 'terminal' && !current.nativeRef) throw executionError('CONTEXT_NATIVE_REFERENCE_MISSING');
            if (settlement.kind === 'terminal' && !validId(settlement.knownHeadRef)) throw executionError('CONTEXT_CHECKPOINT_INVALID');
            if (current.settlement && canonical(current.settlement) !== canonical(settlement)) throw executionError('CONTEXT_SETTLEMENT_CONFLICT');
            return {...current, settlement: structuredClone(settlement)};
        });
    }

    /** The caller persists the prepared revision in its original journal before releasing ownership. */
    async release(id: string, operationId: string, expectedRevision: number): Promise<ContextBinding> {
        return this.update(id, current => {
            if (current && current.revision >= expectedRevision && current.activeOperation?.operationId !== operationId) return current;
            requireOwner(current, operationId);
            if (!current.settlement || current.settlement.operationId !== operationId || current.revision + 1 !== expectedRevision)
                throw executionError('CONTEXT_SETTLEMENT_CONFLICT');
            return {...current, activeOperation: undefined, lastOperation: current.activeOperation, settlement: undefined,
                ...(current.settlement.kind === 'terminal' ? {checkpoints: appendCheckpoint(current)} : {}),
                ...(current.settlement.knownHeadRef !== undefined ? {knownHeadRef: current.settlement.knownHeadRef} : {}),
                ...(!current.nativeRef ? {validity: 'invalid', invalidReason: 'CONTEXT_NATIVE_REFERENCE_UNCONFIRMED'} as const : {})};
        });
    }

    private async read(): Promise<{version: number | null; value: BindingCollection}> {
        return readContextBindingCollection(this.state, this.sessionId);
    }

    private async update(id: string, reduce: (current: ContextBinding | undefined, collection: BindingCollection) => ContextBinding): Promise<ContextBinding> {
        if (!validId(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw executionError('CONTEXT_BINDING_ID_INVALID');
        for (let attempt = 0; attempt < 8; attempt++) {
            const saved = await this.read(), current = ownBinding(saved.value.bindings, id);
            const next = reduce(current, saved.value);
            if (unchanged(current, next)) return structuredClone(current!);
            const binding = {...next, revision: (current?.revision ?? 0) + 1};
            const value = {...saved.value, bindings: {...saved.value.bindings, [id]: binding}};
            assertCollectionLimits(value);
            if (!validCollection(value, this.sessionId)) throw executionError('CONTEXT_STORAGE_INVALID');
            try {await this.state.set(CONTEXT_BINDINGS_KEY, jsonValue(value), saved.version); return structuredClone(binding);}
            catch (error) {
                if ((error as {code?: unknown})?.code !== 'CONFLICT') throw executionError('CONTEXT_STORAGE_WRITE_FAILED');
                if (attempt === 7) throw executionError('CONTEXT_STORAGE_CONFLICT');
            }
        }
        throw executionError('CONTEXT_STORAGE_CONFLICT');
    }
}

function ownBinding(bindings: BindingCollection['bindings'], id: string): ContextBinding | undefined {return Object.hasOwn(bindings, id) ? bindings[id] : undefined;}
function unchanged(current: ContextBinding | undefined, next: ContextBinding): boolean {return !!current && canonical(current) === canonical(next);}

/** Read-only catalog access must not open a Session, acquire a lease or manufacture a write port. */
export async function readContextBindingCollection(state: Pick<EffectSessionState, 'get'>, sessionId: string): Promise<{version: number | null; value: BindingCollection}> {
    const saved = await state.get(CONTEXT_BINDINGS_KEY).catch(error => {throw storageError('CONTEXT_STORAGE_READ_FAILED', error);});
    const value = saved?.value as unknown as BindingCollection | undefined;
    if (saved && (!value || !validCollection(value, sessionId) || !Number.isSafeInteger(saved.version) || saved.version < 1)) throw executionError('CONTEXT_STORAGE_INVALID');
    return {version: saved?.version ?? null, value: structuredClone(value ?? {version: 1, sessionId, bindings: {}})};
}

function newBinding(id: string, sessionId: string, context: HarnessContextRequest, connection: HarnessConnectionSnapshot,
    operation: ContextBindingOperation): ContextBinding {
    return {id, revision: 0, generation: 1, sessionId, connectionId: connection.id, connectionRef: connectionRef(connection),
        branchId: context.branchId, targetRef: context.targetRef, scopeRef: context.scopeRef, policyRef: context.policyRef,
        workspaceRef: context.workspaceRef, memoryPolicyRef: context.memoryPolicyRef, initialContext: inputSnapshot(context.input),
        validity: 'pending', activeOperation: structuredClone(operation)};
}

function forkBinding(id: string, sessionId: string, collection: BindingCollection, context: HarnessContextRequest,
    connection: HarnessConnectionSnapshot, operation: ContextBindingOperation): ContextBinding {
    const selected = context.conversation as Extract<Selection, {mode: 'fork'}>;
    const source = Object.hasOwn(collection.bindings, selected.sourceBindingId) ? collection.bindings[selected.sourceBindingId] : undefined;
    if (!source || source.validity !== 'valid' || !source.nativeRef) throw executionError('CONTEXT_BINDING_INVALID');
    if (source.revision !== selected.expectedBindingRevision || source.generation !== selected.expectedGeneration) throw executionError('CONTEXT_BINDING_CHANGED');
    if (source.activeOperation) throw executionError('CONTEXT_BINDING_BUSY');
    if (source.knownHeadRef !== selected.checkpointRef && !source.checkpoints?.some(checkpoint => checkpoint.ref === selected.checkpointRef))
        throw executionError('CONTEXT_CHECKPOINT_CHANGED');
    assertCompatible(source, context, connection, true);
    return {...newBinding(id, sessionId, context, connection, operation), forkedFrom: {bindingId: source.id, revision: source.revision,
        generation: source.generation, checkpointRef: selected.checkpointRef, nativeRef: structuredClone(source.nativeRef)}};
}

function continueBinding(current: ContextBinding | undefined, context: HarnessContextRequest, connection: HarnessConnectionSnapshot,
    operation: ContextBindingOperation): ContextBinding {
    if (!current) throw executionError('CONTEXT_BINDING_NOT_FOUND');
    const selection = context.conversation as Extract<Selection, {mode: 'continue'}>;
    if (current.id !== selection.bindingId || current.revision !== selection.expectedBindingRevision
        || current.generation !== selection.expectedGeneration) throw executionError('CONTEXT_BINDING_CHANGED');
    if (current.validity !== 'valid') throw executionError('CONTEXT_BINDING_INVALID');
    if (current.activeOperation) throw executionError('CONTEXT_BINDING_BUSY');
    assertCompatible(current, context, connection);
    return {...current, activeOperation: structuredClone(operation)};
}

function assertCompatible(binding: ContextBinding, context: HarnessContextRequest, connection: HarnessConnectionSnapshot, fork = false): void {
    const fields = ['targetRef', 'policyRef', 'workspaceRef', 'memoryPolicyRef', ...(fork ? [] : ['branchId', 'scopeRef'])];
    if (binding.connectionRef !== connectionRef(connection) || fields
        .some(key => binding[key as keyof ContextBinding] !== context[key as keyof HarnessContextRequest])) throw executionError('CONTEXT_POLICY_CHANGED');
}

function requireOwner(binding: ContextBinding | undefined, operationId: string): asserts binding is ContextBinding {
    if (!binding || binding.activeOperation?.operationId !== operationId) throw executionError('CONTEXT_OPERATION_CONFLICT');
}
function sameOperation(left: ContextBindingOperation | undefined, right: ContextBindingOperation): boolean {
    if (left?.operationId !== right.operationId) return false;
    if (canonical(left) !== canonical(right)) throw executionError('CONTEXT_OPERATION_CONFLICT');
    return true;
}
function validId(value: unknown): value is string {return typeof value === 'string' && value.length > 0 && value.length <= 4096;}
function validNativeRef(value: NativeContextRef): boolean {
    return !!value && [value.nodeConnectionId, value.profileId, value.workspaceId, value.sessionId, value.epoch].every(validId);
}
function nativeThreadKey(ref: NativeContextRef): string {return canonical([ref.epoch, ref.profileId, ref.sessionId]);}
function connectionRef(connection: HarnessConnectionSnapshot): string {return sha256HexSync(canonical(connection));}
function validOperation(value: ContextBindingOperation): boolean {
    return !!value && [value.operationId, value.invocationId, value.fingerprint, value.executionRef?.taskId, value.executionRef?.effectId].every(validId);
}
function operationSnapshot(value: ContextBindingOperation): ContextBindingOperation {
    return {operationId: value.operationId, invocationId: value.invocationId, fingerprint: value.fingerprint,
        executionRef: {taskId: value.executionRef.taskId, effectId: value.executionRef.effectId}};
}
function inputSnapshot(input: HarnessContextRequest['input']): HarnessContextRequest['input'] {
    return input.mode === 'host-assembled' ? {mode: input.mode, snapshotRef: input.snapshotRef, digest: input.digest}
        : {mode: input.mode, inputRef: input.inputRef, digest: input.digest};
}
function validCollection(value: BindingCollection, sessionId: string): boolean {
    return value.version === 1 && value.sessionId === sessionId && !!value.bindings && !Array.isArray(value.bindings)
        && typeof value.bindings === 'object' && Object.entries(value.bindings).every(([id, binding]) => validBinding(id, binding, sessionId));
}
function validBinding(id: string, binding: ContextBinding, sessionId: string): boolean {
    if (!binding || binding.id !== id || binding.sessionId !== sessionId) return false;
    return !['__proto__', 'constructor', 'prototype'].includes(id) && [binding.revision, binding.generation].every(value => Number.isSafeInteger(value) && value > 0)
        && [id, binding.branchId, binding.connectionId, binding.connectionRef, binding.targetRef, binding.scopeRef,
            binding.policyRef, binding.workspaceRef, binding.memoryPolicyRef].every(validId) && validBindingState(binding);
}
function validBindingState(binding: ContextBinding): boolean {
    if (!['pending', 'valid', 'invalid'].includes(binding.validity) || binding.validity === 'valid' && !binding.nativeRef) return false;
    if (binding.nativeRef && !validNativeRef(binding.nativeRef)) return false;
    return [binding.knownHeadRef, binding.settlement?.knownHeadRef].every(value => value === undefined || validId(value))
        && validOperationState(binding) && validInitialInput(binding.initialContext) && validForkSource(binding.forkedFrom) && validCheckpoints(binding);
}

function appendCheckpoint(binding: ContextBinding): ContextCheckpoint[] {
    const checkpoints = structuredClone(binding.checkpoints ?? legacyCheckpoints(binding));
    const ref = binding.settlement!.knownHeadRef!, operation = binding.activeOperation!;
    const existing = checkpoints.find(checkpoint => checkpoint.ref === ref);
    if (existing && (existing.kind !== 'terminal' || !sameOperation(existing.operation, operation))) throw executionError('CONTEXT_CHECKPOINT_CONFLICT');
    const previousRef = checkpoints.some(checkpoint => checkpoint.ref === binding.knownHeadRef) ? binding.knownHeadRef : undefined;
    if (!existing) checkpoints.push({kind: 'terminal', ref, operation: structuredClone(operation), ...(previousRef ? {previousRef} : {})});
    return checkpoints;
}
function legacyCheckpoints(binding: ContextBinding): ContextCheckpoint[] {
    return binding.knownHeadRef ? [{kind: 'legacy-head', ref: binding.knownHeadRef}] : [];
}
function validCheckpoints(binding: ContextBinding): boolean {
    if (binding.checkpoints === undefined) return true;
    if (!Array.isArray(binding.checkpoints) || binding.checkpoints.length > 4096) return false;
    const seen = new Set<string>(), owners = new Set<string>(); let prior: string | undefined;
    for (const checkpoint of binding.checkpoints) {
        if (!validCheckpoint(checkpoint) || seen.has(checkpoint.ref) || checkpoint.previousRef !== prior || duplicateOwner(checkpoint, owners, seen.size)) return false;
        seen.add(checkpoint.ref); prior = checkpoint.ref;
    }
    return binding.knownHeadRef === prior;
}
function validCheckpoint(checkpoint: ContextCheckpoint): boolean {
    return !!checkpoint && validId(checkpoint.ref) && (checkpoint.kind === 'terminal' ? validOperation(checkpoint.operation)
        : checkpoint.kind === 'legacy-head' && checkpoint.operation === undefined);
}
function duplicateOwner(checkpoint: ContextCheckpoint, seen: Set<string>, index: number): boolean {
    if (checkpoint.kind === 'legacy-head') return index !== 0;
    if (seen.has(checkpoint.operation.operationId)) return true;
    seen.add(checkpoint.operation.operationId); return false;
}
function storageError(code: string, error: unknown): Error {
    const remoteCode = (error as {code?: unknown})?.code;
    return Object.assign(executionError(code), typeof remoteCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(remoteCode) ? {remoteCode} : {});
}
function validForkSource(source: ContextBinding['forkedFrom']): boolean {
    return source === undefined || !!source && [source.bindingId, source.checkpointRef].every(validId)
        && [source.revision, source.generation].every(value => Number.isSafeInteger(value) && value > 0) && validNativeRef(source.nativeRef);
}
function validOperationState(binding: ContextBinding): boolean {
    if (binding.activeOperation && !validOperation(binding.activeOperation) || binding.lastOperation && !validOperation(binding.lastOperation)) return false;
    if (binding.settlement && (!binding.activeOperation || binding.settlement.operationId !== binding.activeOperation.operationId
        || !['terminal', 'not-started'].includes(binding.settlement.kind))) return false;
    return true;
}
function validInitialInput(input: ContextBinding['initialContext']): boolean {
    return !!input && validId(input.digest) && (input.mode === 'host-assembled' ? validId(input.snapshotRef)
        : input.mode === 'native-continuation' && validId(input.inputRef));
}
function assertCollectionLimits(value: BindingCollection): void {
    if (Object.keys(value.bindings).length > 4096 || Object.values(value.bindings).some(binding => (binding.checkpoints?.length ?? 0) > 4096)
        || new TextEncoder().encode(canonical(value)).byteLength > 8 * 1024 * 1024)
        throw executionError('CONTEXT_BINDING_LIMIT');
}
