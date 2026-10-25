import {sha256HexSync} from '@itookit/common';
import type {ContextBinding, ContextCheckpoint} from '@itookit/kernel-adapters/contracts';
import {directHarnessContextIdentity, type ContextOptionsQuery, type ContextSourceQualification} from '@itookit/llm-session/contracts';
import type {SessionRepository} from '@itookit/llm-session';
import type {HarnessConnectionInspection} from './harness-connections';
import {canonical} from './harness-connection-policy';
import {contextBindingCheckpoints} from './harness-context-catalog';

type Destination = Awaited<ReturnType<SessionRepository['getLoadState']>>;
export function contextOptionsBasis(query: ContextOptionsQuery, destination: Destination, revision: number | null,
    inspection?: HarnessConnectionInspection): string {
    const {manifest, settings} = destination;
    return sha256HexSync(canonical({sessionId: query.sessionId, branchId: query.branchId, target: query.target,
        head: manifest.branches[query.branchId], destinationProfile: manifest.branchMeta[query.branchId]?.contextProfile ?? null,
        initialContext: sha256HexSync(canonical(manifest.initialContext ?? null)),
        mode: {requested: query.overrides?.executionMode ?? null, stored: settings.executionMode ?? null, locked: settings.executionModeLocked ?? false},
        appendDigest: sha256HexSync(query.overrides?.systemPromptAppend ?? ''), revision,
        ...(inspection ? {connection: sha256HexSync(canonical(inspection.snapshot)), epoch: inspection.epoch,
            nativeProfile: inspection.profile, checkpointFork: inspection.checkpointFork, workspaceId: inspection.workspaceId} : {})}));
}
export function checkpointForkSupported(inspection: HarnessConnectionInspection): boolean {
    return inspection.checkpointFork === true && inspection.profile.capabilities.fork === true && inspection.profile.capabilities.checkpointFork === true;
}
export function qualifyContextSource(binding: ContextBinding, query: ContextOptionsQuery,
    inspection: HarnessConnectionInspection): ContextSourceQualification {
    const expected = directHarnessContextIdentity(query.target, inspection.snapshot.project), codes: string[] = [];
    if (!checkpointForkSupported(inspection)) codes.push('CONTEXT_CHECKPOINT_FORK_UNSUPPORTED');
    if (binding.validity !== 'valid' || !binding.nativeRef) codes.push('CONTEXT_BINDING_INVALID');
    if (binding.activeOperation) codes.push('CONTEXT_BINDING_BUSY');
    if (binding.targetRef !== expected.targetRef) codes.push('CONTEXT_TARGET_CHANGED');
    if (binding.connectionRef !== sha256HexSync(canonical(inspection.snapshot))) codes.push('CONTEXT_CONNECTION_CHANGED');
    if (binding.workspaceRef !== expected.workspaceRef) codes.push('CONTEXT_WORKSPACE_CHANGED');
    if (binding.memoryPolicyRef !== expected.memoryPolicyRef) codes.push('CONTEXT_MEMORY_POLICY_CHANGED');
    codes.push(...nativeReferenceIssues(binding, inspection));
    if (!contextBindingCheckpoints(binding).some(checkpoint => checkpoint.kind === 'terminal')) codes.push('CONTEXT_CHECKPOINT_UNCONFIRMED');
    return qualification(codes);
}
function nativeReferenceIssues(binding: ContextBinding, inspection: HarnessConnectionInspection): string[] {
    const ref = binding.nativeRef;
    if (!ref) return [];
    if (ref.epoch !== inspection.epoch) return ['CONTEXT_NATIVE_EPOCH_CHANGED'];
    return ref.nodeConnectionId === inspection.snapshot.nodeConnectionId && ref.profileId === inspection.profile.id
        && ref.workspaceId === inspection.workspaceId ? [] : ['CONTEXT_NATIVE_REFERENCE_CHANGED'];
}
export function qualifyContextCheckpoint(source: ContextSourceQualification, checkpoint: ContextCheckpoint): ContextSourceQualification {
    return qualification([...source.codes, ...(checkpoint.kind === 'terminal' ? [] : ['CONTEXT_CHECKPOINT_UNCONFIRMED'])]);
}
function qualification(codes: string[]): ContextSourceQualification {
    return {status: codes.length ? 'unavailable' : 'static-compatible', codes: [...new Set(codes)]};
}
