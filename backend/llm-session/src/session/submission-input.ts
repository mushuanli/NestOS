import {isAttachmentContentIdentity} from '../contracts/chat';
import {assertTargetSelection, assertFlowCallSource, assertSelectedTarget, isTargetRef, createAgentSendIntent, flowTargetRevision, type SendIntent, type FlowRevision} from '@itookit/llm-flow/contracts';
import type {SubmissionRequest} from '../contracts/submission';
import type {SessionInstructionInput} from '../contracts/instruction-queue';

/** Adapt a typed target to the existing queue without assigning a Flow an Agent identity. */
export function submissionInstruction(request: SubmissionRequest): SessionInstructionInput {
    assertRequestScope(request);
    assertUserPrefix(request.overrides?.userMessagePrefix);
    assertTargetSelection(request.target);
    assertFlowCallSource(request.source);
    assertPresentation(request);
    assertExpectedTarget(request);
    validateSubmission(request.submission);
    if (request.overrides?.flowId) throw invalid('Select a Flow with the typed target instead of flowId overrides');
    const {target, source} = structuredClone(request);
    validateAttachments(request.attachments);
    const execution: SendIntent['execution'] = target.kind === 'flow'
        ? {kind: 'flow', flowId: target.id as FlowRevision['id'], revision: flowTargetRevision(target)} : createAgentSendIntent(target.id).execution;
    return {...(request.branchFrom ? {branchFrom: structuredClone(request.branchFrom)} : {}), target, expectedBranch: request.expectedBranch, expectedTarget: structuredClone(request.expectedTarget), source, text: source.kind === 'composer' ? source.text : request.presentation?.text ?? '', files: structuredClone(request.attachments ?? []),
        agentId: target.kind === 'agent' ? target.id : '', overrides: structuredClone(request.overrides),
        origin: request.origin, historyPolicy: request.historyPolicy,
        sendIntent: {branch: {mode: request.overrides?.branchMode ?? 'continue', baseRoundId: request.overrides?.baseRoundId,
            newBranchName: request.overrides?.newBranchName}, retention: {mode: request.overrides?.retentionMode ?? 'persistent'}, execution,
            submission: structuredClone(request.submission)}};
}

function assertRequestScope(request: SubmissionRequest): void {
    if (!request || typeof request !== 'object') throw invalid('Invalid submission request');
    if (!validOptionalScope(request.expectedSessionId)) throw invalid('Invalid expected Session identity');
    if (!validOptionalScope(request.expectedBranch)) throw invalid('Invalid expected branch');
}
function validOptionalScope(value: unknown): boolean {return value === undefined || typeof value === 'string' && !!value.trim() && value.length <= 1024;}
function assertPresentation(request: SubmissionRequest): void {
    if (request.presentation === undefined) return;
    if (request.source.kind !== 'arguments' || !request.presentation || typeof request.presentation.text !== 'string'
        || Object.keys(request.presentation).some(key => key !== 'text')) throw invalid('Presentation text is only allowed for confirmed argument input');
}
function assertExpectedTarget(request: SubmissionRequest): void {
    if (request.expectedTarget === undefined) return;
    if (!isTargetRef(request.expectedTarget)) throw invalid('Invalid expected target reference');
    assertSelectedTarget(request.target, request.expectedTarget);
}

export function assertSubmissionBinding(request: SubmissionRequest, sessionId: string): void {
    if (request.expectedSessionId !== undefined && request.expectedSessionId !== sessionId
        || request.submission?.source.kind === 'conversation' && request.submission.source.ownerId !== sessionId)
        throw Object.assign(new Error('Session changed before call admission'), {code: 'SUBMISSION_BINDING_CHANGED'});
}

function validateSubmission(value: SubmissionRequest['submission']): void {
    if (value === undefined) return;
    if (!value || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id) || !value.source
        || !['kind', 'ownerId', 'id'].every(key => {
            const field = value.source[key as keyof typeof value.source];
            return typeof field === 'string' && !!field.trim() && field.length <= 1024;
        })) throw invalid('Invalid submission correlation');
}

function validateAttachments(files: SubmissionRequest['attachments']): void {
    if (files === undefined) return;
    if (!Array.isArray(files) || !files.every(validPreparedAttachment))
        throw invalid('Typed calls require prepared attachment references');
}
function validPreparedAttachment(file: NonNullable<SubmissionRequest['attachments']>[number]): boolean {
    if (!file || typeof file.name !== 'string' || typeof file.type !== 'string') return false;
    if (file.path !== undefined && typeof file.path !== 'string') return false;
    if (!validPreparedSize(file.size)) return false;
    if (file.content !== undefined && !isAttachmentContentIdentity(file.content)) return false;
    return Object.keys(file).every(key => ['name', 'type', 'path', 'size', 'content'].includes(key));
}
function validPreparedSize(value: number | undefined): boolean {return value === undefined || Number.isFinite(value) && value >= 0;}

function invalid(message: string): Error {return Object.assign(new Error(message), {code: 'SUBMISSION_INVALID'});}

function assertUserPrefix(value: unknown): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 128 || value.some(message => !message || message.role !== 'user'
        || typeof message.content !== 'string' && !Array.isArray(message.content)
        || message.tool_calls || message.tool_call_id)) throw invalid('Additional input must contain only user messages');
}
