/** Native context identity is independent of calls, Kernel tasks and operation receipts. */
export type ConversationSelection =
    | {mode: 'new'; seedContextRef?: string}
    | {mode: 'continue'; bindingId: string; expectedBindingRevision: number; expectedGeneration: number}
    | {mode: 'fork'; sourceBindingId: string; expectedBindingRevision: number; expectedGeneration: number; checkpointRef: string};

export interface HarnessContextRequest {
    invocationId: string;
    branchId: string;
    targetRef: string;
    scopeRef: string;
    policyRef: string;
    workspaceRef: string;
    memoryPolicyRef: string;
    input: {mode: 'host-assembled'; snapshotRef: string; digest: string}
        | {mode: 'native-continuation'; inputRef: string; digest: string};
    conversation: ConversationSelection;
}

export interface NativeContextRef {
    nodeConnectionId: string;
    profileId: string;
    workspaceId: string;
    sessionId: string;
    epoch: string;
}

export interface ContextBinding {
    id: string;
    revision: number;
    generation: number;
    sessionId: string;
    branchId: string;
    connectionId: string;
    connectionRef: string;
    targetRef: string;
    scopeRef: string;
    policyRef: string;
    workspaceRef: string;
    memoryPolicyRef: string;
    validity: 'pending' | 'valid' | 'invalid';
    invalidReason?: string;
    nativeRef?: NativeContextRef;
    /** An observed head never grants conditional write capability by itself. */
    knownHeadRef?: string;
    /** Confirmed heads remain addressable after later invocations advance this binding. */
    checkpoints?: ContextCheckpoint[];
    initialContext: HarnessContextRequest['input'];
    forkedFrom?: {bindingId: string; revision: number; generation: number; checkpointRef: string; nativeRef: NativeContextRef};
    activeOperation?: ContextBindingOperation;
    lastOperation?: ContextBindingOperation;
    settlement?: {operationId: string; kind: 'terminal' | 'not-started'; knownHeadRef?: string};
}

export interface ContextBindingOperation {
    operationId: string;
    invocationId: string;
    fingerprint: string;
    executionRef: {taskId: string; effectId: string};
}

export interface ContextBindingRef {bindingId: string; revision: number; generation: number}

export type ContextCheckpoint = {ref: string; previousRef?: string} & (
    | {kind: 'terminal'; operation: ContextBindingOperation}
    | {kind: 'legacy-head'; operation?: never}
);

export function assertHarnessContextRequest(value: HarnessContextRequest): void {
    if (!validRequestFields(value)) fail('CONTEXT_REQUEST_INVALID');
    const selection = value.conversation;
    assertConversationSelection(selection);
    if (selection.mode === 'new') {
        if (!validNewInput(value.input, selection)) fail('CONTEXT_INPUT_MODE_INVALID');
    } else if (!validExistingInput(value.input, selection)) fail('CONTEXT_INPUT_MODE_INVALID');
}

export function assertConversationSelection(selection: ConversationSelection): void {
    if (!selection || typeof selection !== 'object' || !['new', 'continue', 'fork'].includes(selection.mode)) fail('CONTEXT_REQUEST_INVALID');
    const fields = selectionFields(selection);
    if (!Object.keys(selection).every(key => fields.includes(key))) fail('CONTEXT_REQUEST_INVALID');
    if (selection.mode === 'new') {
        if (selection.seedContextRef !== undefined && !reference(selection.seedContextRef)) fail('CONTEXT_INPUT_MODE_INVALID');
    } else if (!validExistingSelection(selection)) fail('CONTEXT_INPUT_MODE_INVALID');
}
function selectionFields(selection: ConversationSelection): string[] {
    if (selection.mode === 'new') return ['mode', 'seedContextRef'];
    return ['mode', 'expectedBindingRevision', 'expectedGeneration', ...(selection.mode === 'continue' ? ['bindingId'] : ['sourceBindingId', 'checkpointRef'])];
}

function validRequestFields(value: HarnessContextRequest): boolean {
    return !!value && typeof value === 'object' && ['invocationId', 'branchId', 'targetRef', 'scopeRef', 'policyRef', 'workspaceRef', 'memoryPolicyRef']
        .every(key => reference(value[key as keyof HarnessContextRequest])) && !!value.input && reference(value.input.digest);
}

function validNewInput(input: HarnessContextRequest['input'], selection: Extract<ConversationSelection, {mode: 'new'}>): boolean {
    return input.mode === 'host-assembled' && reference(input.snapshotRef)
        && (selection.seedContextRef === undefined || reference(selection.seedContextRef));
}
function validExistingInput(input: HarnessContextRequest['input'], selection: Exclude<ConversationSelection, {mode: 'new'}>): boolean {
    return input.mode === 'native-continuation' && reference(input.inputRef) && validExistingSelection(selection);
}
function validExistingSelection(selection: Exclude<ConversationSelection, {mode: 'new'}>): boolean {
    return positiveInteger(selection.expectedBindingRevision) && positiveInteger(selection.expectedGeneration)
        && (selection.mode === 'continue' ? reference(selection.bindingId) : reference(selection.sourceBindingId) && reference(selection.checkpointRef));
}
function reference(value: unknown): value is string {return typeof value === 'string' && value.length > 0 && value.length <= 4096;}
function positiveInteger(value: number): boolean {return Number.isSafeInteger(value) && value > 0;}
function fail(code: string): never {throw Object.assign(new Error(`Harness context: ${code}`), {code});}
