import {canonical} from '../projects/harness-connection-policy';
import {sha256HexSync} from '@itookit/common';
import type {AgentDefinition, AgentPublishRequest, IAgentManagementService} from '@itookit/kernel-adapters/contracts';
import type {TargetRef} from '@itookit/llm-flow/contracts';
import {FSError} from '@itookit/vfs-core';

interface Journal {get<T>(key: string): Promise<T | undefined>; update<T>(key: string, change: (old: T | undefined) => T): Promise<T>}
interface ManagedAgent {definition: AgentDefinition; digest: string; publication?: AgentPublishRequest; target?: TargetRef}

/** Ownership is journaled before creation; publication is reconciled by its original request. */
export async function publishManagedAgent(service: IAgentManagementService, journal: Journal, definition: AgentDefinition): Promise<TargetRef> {
    if (!service.getAgentPublicationStatus || !service.getAgentPublicationReceipt || !service.publishAgent) throw new FSError('ECAPABILITY', 'Agent publication unavailable');
    const key = 'managed-agent:' + definition.id, digest = sha256HexSync(canonical(JSON.parse(JSON.stringify(definition))));
    const old = await journal.get<ManagedAgent>(key);
    if (!old && await service.getAgentConfig(definition.id)) throw new FSError('EEXIST', 'Managed Agent identity is already in use');
    let saved = await journal.update<ManagedAgent>(key, previous => {
        if (previous && previous.digest !== digest) throw new FSError('ECONFLICT', 'Managed Agent definition changed');
        return previous ?? {definition, digest};
    });
    if (saved.target) return saved.target;
    if (!saved.publication) {
        const existing = await service.getAgentConfig(definition.id);
        if (existing) {
            const {availability: _availability, ...source} = existing;
            if (sha256HexSync(canonical(JSON.parse(JSON.stringify(source)))) !== digest) throw new FSError('ECONFLICT', 'Managed Agent source changed before publication');
        }
        if (!existing) await service.saveAgent(definition, {onDuplicate: 'error'});
        const status = await service.getAgentPublicationStatus(definition.id);
        saved = await journal.update<ManagedAgent>(key, previous => ({...previous!, publication: previous!.publication ?? {
            agentId: definition.id, operationId: 'publish-' + definition.id, expectedSourceDigest: status.sourceDigest,
            expectedRevisionDigest: status.draftDigest, expectedPublishedVersion: status.latest?.target.version ?? null}}));
    }
    const published = await service.getAgentPublicationReceipt(saved.publication!) ?? await service.publishAgent(saved.publication!);
    await journal.update<ManagedAgent>(key, previous => ({...previous!, target: published.target}));
    return published.target;
}
