import type {IFileSystem, ISeqFileTransaction} from '@itookit/vfs-core';
import type {AgentPublishedRevision, AgentPublishRequest, AgentRevisionContent} from '@itookit/kernel-adapters/contracts';
import {agentRevisionDigest, agentSourceDigest, canonicalAgentJson} from '../services/agent-definition-digest';
import {assertAgentRevisionContent} from './agent-revision-validation';

export const AGENT_REVISIONS_FILE = '/.agent-publications.seq';
interface Receipt {request: AgentPublishRequest; version: string}

/** Definition revisions and publication receipts share the existing VFS definition plane. */
export class AgentRevisionStore {
    constructor(private readonly fs: IFileSystem) {}

    async get(id: string, version?: string): Promise<AgentPublishedRevision | null> {
        const selected = version ?? await this.head(id);
        if (!selected) return null;
        const record = await this.read<AgentPublishedRevision>(revisionKey(id, selected));
        if (!record) {if (version !== undefined) return null; throw publicationError('AGENT_REVISION_MISSING');}
        assertRevision(record, id, selected); return structuredClone(record);
    }

    async head(id: string): Promise<string | null> {
        const head = await this.read<{version: string}>(headKey(id));
        if (!head) return null;
        if (!/^ap1_[a-f0-9]{64}$/.test(head.version)) throw publicationError('AGENT_REVISION_INTEGRITY');
        return head.version;
    }

    async receipt(request: AgentPublishRequest): Promise<AgentPublishedRevision | null> {
        assertPublishRequest(request);
        const receipt = await this.read<Receipt>(receiptKey(request.operationId));
        if (!receipt) return null;
        assertSameRequest(receipt.request, request);
        const revision = await this.get(request.agentId, receipt.version);
        if (!revision) throw publicationError('AGENT_REVISION_MISSING');
        return revision;
    }

    async publish(request: AgentPublishRequest, content: AgentRevisionContent): Promise<AgentPublishedRevision> {
        assertPublishRequest(request);
        assertAgentRevisionContent(content);
        if (content.definition.id !== request.agentId || content.sourceDigest !== request.expectedSourceDigest
            || agentSourceDigest(content.definition) !== content.sourceDigest) throw publicationError('AGENT_SOURCE_CHANGED');
        const digest = agentRevisionDigest(content), target = {kind: 'agent' as const, id: request.agentId, version: `ap1_${digest}`, digest};
        if (digest !== request.expectedRevisionDigest) throw publicationError('AGENT_PUBLICATION_DEPENDENCY_CHANGED');
        const revision: AgentPublishedRevision = {...structuredClone(content), schemaVersion: 1, target, createdAt: Date.now()};
        assertRevision(revision, request.agentId, target.version); await this.ensureFile();
        try {return await this.commit(request, revision);}
        catch (error) {
            if (isPublicationError(error)) throw error;
            let issue = error;
            const confirmed = await this.receipt(request).catch(readError => {issue = readError; return null;});
            if (confirmed) return confirmed;
            throw Object.assign(publicationError('AGENT_PUBLICATION_WRITE_UNCONFIRMED'), {outcome: 'unknown', cause: issue, remoteCode: storageCode(issue)});
        }
    }

    private async commit(request: AgentPublishRequest, revision: AgentPublishedRevision): Promise<AgentPublishedRevision> {
        return this.fs.meta.seq!.transaction!(async tx => {
            const prior = parse<Receipt>(await tx.getEntry(AGENT_REVISIONS_FILE, receiptKey(request.operationId)));
            if (prior) {
                assertSameRequest(prior.request, request);
                return readTransactionRevision(tx, request.agentId, prior.version);
            }
            const head = parse<{version: string}>(await tx.getEntry(AGENT_REVISIONS_FILE, headKey(request.agentId)));
            if ((head?.version ?? null) !== request.expectedPublishedVersion) throw publicationError('AGENT_PUBLICATION_CONFLICT');
            const existing = parse<AgentPublishedRevision>(await tx.getEntry(AGENT_REVISIONS_FILE, revisionKey(request.agentId, revision.target.version)));
            if (existing) assertRevision(existing, request.agentId, revision.target.version);
            const result = existing ?? revision;
            await tx.setEntry(AGENT_REVISIONS_FILE, revisionKey(request.agentId, revision.target.version), JSON.stringify(result));
            await tx.setEntry(AGENT_REVISIONS_FILE, headKey(request.agentId), JSON.stringify({version: result.target.version}));
            await tx.setEntry(AGENT_REVISIONS_FILE, receiptKey(request.operationId), JSON.stringify({request, version: result.target.version}));
            return structuredClone(result);
        });
    }

    private async read<T>(key: string): Promise<T | null> {
        if (!await this.fs.driver.exists(AGENT_REVISIONS_FILE)) return null;
        return parse<T>(await this.fs.meta.seq!.getEntry(AGENT_REVISIONS_FILE, key));
    }
    private async ensureFile(): Promise<void> {
        if (!this.fs.meta.seq?.transaction) throw publicationError('AGENT_PUBLICATION_UNSUPPORTED');
        if (await this.fs.driver.exists(AGENT_REVISIONS_FILE)) return;
        try {await this.fs.driver.createFile({parentPath: '/', name: '.agent-publications.seq', type: 'seqfile'});}
        catch (error) {if (!await this.fs.driver.exists(AGENT_REVISIONS_FILE)) throw error;}
    }
}

async function readTransactionRevision(tx: ISeqFileTransaction, id: string, version: string): Promise<AgentPublishedRevision> {
    const record = parse<AgentPublishedRevision>(await tx.getEntry(AGENT_REVISIONS_FILE, revisionKey(id, version)));
    if (!record) throw publicationError('AGENT_REVISION_MISSING');
    assertRevision(record, id, version); return structuredClone(record);
}
export function assertPublishRequest(request: AgentPublishRequest): void {
    if (!validRequestIdentity(request))
        throw publicationError('AGENT_PUBLICATION_REQUEST_INVALID');
    if (![request.expectedSourceDigest, request.expectedRevisionDigest].every(validDigest))
        throw publicationError('AGENT_PUBLICATION_REQUEST_INVALID');
    if (request.expectedPublishedVersion !== null && (typeof request.expectedPublishedVersion !== 'string' || !/^ap1_[a-f0-9]{64}$/.test(request.expectedPublishedVersion)))
        throw publicationError('AGENT_PUBLICATION_REQUEST_INVALID');
    if (Object.keys(request).some(key => !['agentId', 'operationId', 'expectedSourceDigest', 'expectedRevisionDigest', 'expectedPublishedVersion'].includes(key)))
        throw publicationError('AGENT_PUBLICATION_REQUEST_INVALID');
}
function validRequestIdentity(request: AgentPublishRequest): boolean {
    return !!request && typeof request.agentId === 'string' && !!request.agentId.trim() && request.agentId.length <= 1024
        && typeof request.operationId === 'string' && /^[\w-]{1,128}$/.test(request.operationId);
}
function validDigest(value: unknown): boolean {return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);}
function assertRevision(record: AgentPublishedRevision, id: string, version: string): void {
    try {assertAgentRevisionContent(record);} catch {throw publicationError('AGENT_REVISION_INTEGRITY');}
    if (record.schemaVersion !== 1 || record.definition.id !== id || !validRevisionTarget(record.target, id, version)
        || agentRevisionDigest(record) !== record.target.digest || agentSourceDigest(record.definition) !== record.sourceDigest
        || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0)
        throw publicationError('AGENT_REVISION_INTEGRITY');
}
function validRevisionTarget(target: AgentPublishedRevision['target'], id: string, version: string): boolean {
    return !!target && target.id === id && target.kind === 'agent' && target.version === version && validDigest(target.digest)
        && version === `ap1_${target.digest}` && Object.keys(target).every(key => ['kind', 'id', 'version', 'digest'].includes(key));
}
function assertSameRequest(left: AgentPublishRequest, right: AgentPublishRequest): void {
    if (canonicalAgentJson(left) !== canonicalAgentJson(right)) throw publicationError('AGENT_PUBLICATION_OPERATION_CONFLICT');
}
function parse<T>(text: string | null): T | null {
    if (text === null) return null;
    try {return JSON.parse(text) as T;} catch {throw publicationError('AGENT_REVISION_INTEGRITY');}
}
function headKey(id: string): string {return `head:${JSON.stringify(id)}`;}
function revisionKey(id: string, version: string): string {return `revision:${JSON.stringify(id)}:${version}`;}
function receiptKey(id: string): string {return `operation:${id}`;}
export function publicationError(code: string): Error {return Object.assign(new Error(code), {code});}
function storageCode(error: unknown): string | undefined {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}
function isPublicationError(error: unknown): boolean {return typeof (error as {code?: unknown})?.code === 'string' && /^(AGENT_(PUBLICATION|REVISION|SOURCE)_)/.test((error as {code: string}).code);}
