import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import type {Kernel} from '@itookit/durable-kernel';
import {readContextCatalog} from '../projects/harness-context-catalog';
import type {FileReply} from './file-exchange-protocol';
import {failure} from './prompt-bundle';
/** Refresh the binding revision while preserving the exact original Session and native context. */
export async function prepareFileContinuation(input: {kernel: Pick<Kernel, 'inspectSession' | 'sessionActivity'>;
    base: SubmissionRequest; sessionId: string; connectionId: string; id: string; paths: FileReply[]}): Promise<SubmissionRequest> {
    const {base, sessionId, kernel} = input, branch = base.expectedBranch!;
    const activity = await kernel.sessionActivity(sessionId);
    if (Object.entries(activity.counts).some(([key, count]) => ['running', 'queued', 'created', 'waiting', 'blocked', 'paused'].includes(key) && count > 0)) throw failure('FILE_EXCHANGE_SESSION_BUSY');
    const catalog = await readContextCatalog(kernel, sessionId);
    const bindings = Object.values(catalog.value.bindings).filter(row => row.branchId === branch && row.connectionId === input.connectionId);
    if (bindings.length !== 1 || bindings[0].validity !== 'valid' || bindings[0].activeOperation || !bindings[0].nativeRef) throw failure('FILE_EXCHANGE_CONTEXT_UNAVAILABLE');
    const binding = bindings[0], original = base.overrides?.harnessConversation;
    if (original && original.mode === 'resume' && (original.bindingId !== binding.id || original.expectedGeneration !== binding.generation)) throw failure('FILE_EXCHANGE_CONTEXT_CHANGED');
    let message: Record<string, unknown> = {};
    if (base.source.kind === 'composer') {try {const value = JSON.parse(base.source.text); message = value && typeof value === 'object' && !Array.isArray(value) ? value : {instruction: base.source.text};} catch {message = {instruction: base.source.text};}}
    const dependencies = message.dependencies && typeof message.dependencies === 'object' ? message.dependencies : {};
    const text = JSON.stringify({...message, dependencies: {...dependencies, fileExchange: {responses: input.paths}},
        continuation: 'Resume ONLY the paused operation in this SAME Session and worktree. Read the listed immutable response files, verify each file SHA-256 against the supplied sha256 and replyTo/scopeId/requestDigest against your requests, and use their revisioned context. Do not rerun completed development, planning, or lifecycle hooks. Preserve the original commit policy and output scope. If more context is needed publish another request and yield; publish the original final result ONLY when the operation is actually complete.'});
    return {...base, expectedSessionId: sessionId, source: {kind: 'composer', text, attachments: [], values: {}},
        submission: {id: input.id, source: {kind: 'conversation', ownerId: sessionId, id: input.id}},
        overrides: {...base.overrides, baseRoundId: undefined, newBranchName: undefined, branchMode: 'continue',
            harnessConversation: {mode: 'resume', bindingId: binding.id, expectedBindingRevision: binding.revision, expectedGeneration: binding.generation}}};
}
