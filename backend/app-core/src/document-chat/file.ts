import {DOCUMENT_CHAT_META_KEY} from '@itookit/app-contracts';
import {FSError} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {SessionCommand, type SubmissionRequest, type SessionGroup} from '@itookit/llm-session/contracts';
import type {DocumentChatFile, DocumentChatFileRequest, DocumentChatLink, DocumentChatResponse, LocalApplicationServices} from '@itookit/app-contracts/services';
import {DocumentChatRegistry} from './registry';

const metaKey = DOCUMENT_CHAT_META_KEY, log = createModuleLogger('document-chat-links');
interface FileMeta {schemaVersion: 1; documentId: string; anchors: Record<string, {linkId: string}>}
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

/** This borrowed file capability owns only observers, never the filesystem or Session. */
export class DocumentChatFileView implements DocumentChatFile {
    private closed = false;
    private fileIdentity?: string;
    private stops = new Set<() => void>();
    private registry: DocumentChatRegistry;
    constructor(private services: LocalApplicationServices, private request: DocumentChatFileRequest) {
        this.registry = new DocumentChatRegistry(services);
    }
    private async metadata(): Promise<FileMeta | undefined> {
        if (this.closed) throw new FSError('ECAPABILITY', 'Document chat file view is closed');
        const node = await this.request.files.driver.getNode(this.request.path);
        if (!node || node.type !== 'file') throw new FSError('ENOENT', 'Document no longer exists');
        this.fileIdentity = node.sourceIdentity;
        const value = node.metadata[metaKey] as FileMeta | undefined;
        if (value && (value.schemaVersion !== 1 || !validId(value.documentId) || (!value.anchors || typeof value.anchors !== 'object' || Array.isArray(value.anchors))))
            throw new FSError('EINVAL', 'Document chat metadata is invalid');
        // Shared files expose stable anchors only; conversation state belongs to the user's registry.
        return value ? {schemaVersion: 1, documentId: value.documentId, anchors: Object.fromEntries(
            Object.keys(value.anchors).map(anchorId => [anchorId, {linkId: `${value.documentId}:${anchorId}`}]))} : undefined;
    }
    private async writeMetadata(meta: FileMeta | undefined, operationId: string): Promise<void> {
        const started = Date.now();
        try {
            await this.request.files.driver.updateMetadata(this.request.path, {[metaKey]: meta});
            log.info('document.chat.metadata', {operationId, stage: 'shared-anchors', result: 'success',
                anchorCount: Object.keys(meta?.anchors ?? {}).length, durationMs: Date.now() - started});
        } catch (error) {
            log.warn('document.chat.metadata', {operationId, stage: 'shared-anchors', result: 'failure',
                code: (error as {code?: string})?.code ?? 'METADATA_WRITE_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    }
    private async record(anchorId: string): Promise<DocumentChatLink | undefined> {
        if (!validId(anchorId)) throw new FSError('EINVAL', 'Invalid document chat anchor');
        const meta = await this.metadata();
        let record = meta ? await this.registry.read(`${meta.documentId}:${anchorId}`)
            : await this.registry.source(this.request.files.viewId, this.request.path, anchorId);
        if (!record) return;
        const sameFile = !!this.fileIdentity && record.source.fileIdentity === this.fileIdentity;
        if (record.source.namespaceId !== this.request.files.viewId && !sameFile) return;
        if (record.source.path !== this.request.path || record.source.namespaceId !== this.request.files.viewId) {
            if (!sameFile && await this.request.files.driver.exists(record.source.path)) return;
            return this.registry.save({...record, source: {...record.source, namespaceId: this.request.files.viewId, path: this.request.path, fileIdentity: this.fileIdentity}, projectionPending: true}, record);
        }
        if (record.source.fileIdentity && this.fileIdentity && !sameFile) return;
        return record;
    }
    async create(anchorId: string, selection: string, defaultPrompt = ''): Promise<DocumentChatLink> {
        return this.registry.serialize(async () => {
            if (!validId(anchorId) || typeof selection !== 'string' || typeof defaultPrompt !== 'string' || selection.length > 64 * 1024 || defaultPrompt.length > 64 * 1024)
                throw new FSError('EINVAL', 'Invalid document chat anchor or selection size');
            const existing = await this.record(anchorId); if (existing) return this.project(existing);
            let meta = await this.metadata();
            const previous = meta && await this.registry.read(`${meta.documentId}:${anchorId}`);
            if (previous && (previous.source.namespaceId !== this.request.files.viewId || previous.source.path !== this.request.path || previous.source.fileIdentity && this.fileIdentity && previous.source.fileIdentity !== this.fileIdentity)) meta = undefined;
            const documentId = meta?.documentId ?? randomUUID(), project = this.request.projectFolder
                ? await this.services.projects.forFolder(this.request.projectFolder) : undefined;
            if (this.request.projectFolder && !project) throw new FSError('ENOENT', 'Source project no longer exists');
            const link: DocumentChatLink = {schemaVersion: 1, id: `${documentId}:${anchorId}`, documentId, anchorId,
                source: {namespaceId: this.request.files.viewId, fileIdentity: this.fileIdentity, path: this.request.path, projectFolder: this.request.projectFolder, projectId: project?.project.id},
                selection, defaultPrompt, revision: 0, status: 'unbound', createdAt: Date.now(), updatedAt: Date.now(), projectionPending: true};
            return this.project(await this.registry.save(link));
        });
    }
    async get(anchorId: string, includeResponse = false) {
        return this.registry.serialize(async () => {
            let link = await this.record(anchorId); if (!link) return {};
            link = await this.refresh(link);
            const bound = link.binding && ['bound', 'detached'].includes(link.status);
            const response = includeResponse && bound ? await this.response(link) : undefined;
            const roundId = bound ? link.latestRoundId ?? link.binding!.initialRoundId : undefined;
            const latest = roundId ? includeResponse && roundId === link.binding!.initialRoundId ? response : await this.response(link, roundId, includeResponse) : undefined;
            const activity = roundId ? {id: latest?.id ?? `round-${roundId}-assistant`, operationId: roundId,
                status: latest?.status ?? 'pending' as const, ...(includeResponse ? {markdown: latest?.markdown ?? ''} : {})} : undefined;
            return {link, response, activity};
        });
    }
    private async refresh(link: DocumentChatLink): Promise<DocumentChatLink> {
        if (link.pending) {
            const receipt = await this.services.commandBus.execute<{status: string}>(SessionCommand.InspectSubmissionReceipt, link.pending);
            if (receipt.status === 'accepted') link = await this.commitBinding(link, link.pending);
        }
        if (link.binding && link.status === 'bound') {
            try {
                const manifest = await this.services.sessionRepository.getManifest(link.binding.sessionId);
                if (!Object.hasOwn(manifest.branches, link.binding.branch))
                    link = await this.registry.save({...link, status: 'missing', endpoint: undefined, projectionPending: true}, link);
            } catch (error) {
                if (!(error instanceof FSError) || error.code !== 'ENOENT') throw error;
                link = await this.registry.save({...link, status: 'missing', endpoint: undefined, projectionPending: true}, link);
            }
        }
        return link.projectionPending ? this.project(link, false) : link;
    }
    async reserve(anchorId: string, operationId: string): Promise<DocumentChatLink> {
        return this.registry.serialize(async () => {
            if (!validId(operationId)) throw new FSError('EINVAL', 'Invalid document chat operation');
            let link = await this.record(anchorId); if (!link) throw new FSError('ENOENT', 'Document chat anchor is missing');
            if (link.status === 'detached') link = await this.registry.save({...link,
                status: link.binding ? 'bound' : 'unbound', projectionPending: true}, link);
            link = await this.refresh(link);
            if (link.pending && link.pending.submission?.id !== operationId)
                throw new FSError('EBUSY', 'The previous submission is awaiting its original receipt; retry it before editing');
            if (link.status === 'bound' || link.endpoint) return link;
            return this.project(await this.registry.save({...link, status: 'unbound', binding: undefined,
                endpoint: {sessionId: randomUUID(), branch: randomUUID().slice(0, 6)}, projectionPending: true}, link));
        });
    }
    async prepare(anchorId: string, request: SubmissionRequest): Promise<void> {
        await this.registry.serialize(async () => {
            const link = await this.record(anchorId); if (!link?.endpoint && !link?.binding) throw new FSError('ENOENT', 'Document chat endpoint is missing');
            const endpoint = link.binding ?? link.endpoint!;
            if (endpoint.sessionId !== request.expectedSessionId || endpoint.branch !== request.expectedBranch || !request.submission?.id)
                throw new FSError('ECONFLICT', 'Submission does not belong to this document chat');
            if (link.pending && JSON.stringify(link.pending) !== JSON.stringify(request)) throw new FSError('ECONFLICT', 'A different submission is already pending');
            if (!link.pending) await this.registry.save({...link, pending: structuredClone(request)}, link);
        });
    }
    async bind(anchorId: string, request: SubmissionRequest): Promise<DocumentChatLink> {
        return this.registry.serialize(async () => {
            const link = await this.record(anchorId); if (!link) throw new FSError('ENOENT', 'Document chat anchor is missing');
            const receipt = await this.services.commandBus.execute<{status: string}>(SessionCommand.InspectSubmissionReceipt, request);
            if (receipt.status !== 'accepted') throw new FSError('EBUSY', 'Document chat admission is not confirmed');
            if (link.pending && JSON.stringify(link.pending) !== JSON.stringify(request)) throw new FSError('ECONFLICT', 'Submission identity changed');
            return this.project(await this.commitBinding(link, request), false);
        });
    }
    private async commitBinding(link: DocumentChatLink, request: SubmissionRequest): Promise<DocumentChatLink> {
        const endpoint = link.binding ?? link.endpoint;
        if (!endpoint || endpoint.sessionId !== request.expectedSessionId || endpoint.branch !== request.expectedBranch)
            throw new FSError('ECONFLICT', 'Submission does not belong to this document chat');
        const binding = link.binding ? link.binding : {sessionId: request.expectedSessionId!, branch: request.expectedBranch!, initialRoundId: request.submission!.id, initialMessageId: `round-${request.submission!.id}-assistant`};
        if (!binding || binding.sessionId !== request.expectedSessionId || binding.branch !== request.expectedBranch)
            throw new FSError('ECONFLICT', 'Document chat branch changed');
        if (!link.pending && link.binding && link.target?.digest === request.expectedTarget?.digest && link.latestRoundId === request.submission!.id) return link;
        return this.registry.save({...link, binding, endpoint: {sessionId: binding.sessionId, branch: binding.branch}, target: request.expectedTarget,
            pending: undefined, latestRoundId: request.submission!.id, status: link.status === 'detached' ? 'detached' : 'bound', projectionPending: true}, link);
    }
    private async project(link: DocumentChatLink, strict = true): Promise<DocumentChatLink> {
        const started = Date.now();
        if (link.status === 'detached') return link.projectionPending ? this.registry.save({...link, projectionPending: false}, link) : link;
        try {
            const meta = await this.metadata();
            const anchors = meta?.documentId === link.documentId ? {...meta.anchors} : {};
            anchors[link.anchorId] = {linkId: link.id};
            await this.writeMetadata({schemaVersion: 1, documentId: link.documentId, anchors}, link.anchorId);
            const identity = (await this.request.files.driver.getNode(this.request.path))?.sourceIdentity;
            return link.projectionPending || identity !== link.source.fileIdentity
                ? await this.registry.save({...link, source: {...link.source, fileIdentity: identity}, projectionPending: false}, link) : link;
        } catch (error) {
            log.warn('document.chat.projection', {linkId: link.id, operationId: link.pending?.submission?.id ?? link.anchorId, durationMs: Date.now() - started, stage: 'file-metadata', result: 'failure', code: (error as {code?: string})?.code ?? 'PROJECTION_FAILED'});
            if (strict) throw error;
            return link;
        }
    }
    private async response(link: DocumentChatLink, roundId = link.binding!.initialRoundId, includeMarkdown = true): Promise<DocumentChatResponse | undefined> {
        const binding = link.binding!, raw = await this.services.sessionRepository.readDocument(binding.sessionId, `round-${roundId}.json`);
        if (!raw) return;
        const round = JSON.parse(raw) as {status: string; executions?: Array<{taskId: string; role: string}>; output?: Array<{role: string; content: string | Array<{type: string; text?: string}>}>};
        const messages = (round.output ?? []).filter(message => message.role === 'assistant');
        let markdown = includeMarkdown ? messages.map(message => typeof message.content === 'string' ? message.content
            : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '').join('\n\n').slice(0, 64 * 1024) : '';
        // Round files contain the terminal result; partial tokens live in the existing Session projection.
        // Acquire only for an explicitly expanded, running AI reply, never for ordinary file opening.
        if (includeMarkdown && ['pending', 'running', 'waiting'].includes(round.status) && round.executions?.length && this.services.acquireConversation) {
            const conversation = await this.services.acquireConversation(binding.sessionId);
            try {
                const groups = await conversation.commandBus.execute<SessionGroup[]>(SessionCommand.GetSessions);
                const primary = round.executions.find(execution => execution.role === 'primary')?.taskId;
                const group = groups.find(group => group.role === 'assistant' && (group.roundId === roundId
                    || group.persistedNodeId === roundId || !!primary && group.execution?.taskId === primary));
                const partial = group?.executionRoot?.data.output ?? group?.content;
                if (typeof partial === 'string' && partial) markdown = partial.slice(0, 64 * 1024);
            } finally {await conversation.dispose();}
        }
        return {id: roundId === binding.initialRoundId ? binding.initialMessageId ?? `round-${roundId}-assistant` : `round-${roundId}-assistant`, markdown,
            status: round.status === 'completed' ? 'completed' : ['failed', 'cancelled'].includes(round.status) ? 'failed' : 'pending'};
    }
    async reconcile(anchorIds: string[]): Promise<void> {
        await this.registry.serialize(async () => {
            const meta = await this.metadata(), live = new Set(anchorIds);
            if (anchorIds.length > 1000 || anchorIds.some(id => !validId(id))) throw new FSError('EINVAL', 'Invalid document anchor set');
            let changed = false;
            if (meta) for (const id of Object.keys(meta.anchors)) if (!live.has(id)) {
                const link = await this.record(id);
                if (link && link.status !== 'detached') await this.registry.save({...link, status: 'detached'}, link);
                delete meta.anchors[id]; changed = true;
            }
            if (changed) await this.writeMetadata(Object.keys(meta!.anchors).length ? meta : undefined, randomUUID());
            for (const id of live) {
                let link = await this.record(id);
                if (link?.status === 'detached') {
                    link = await this.registry.save({...link, status: link.binding ? 'bound' : 'unbound', projectionPending: true}, link);
                    await this.refresh(link);
                }
            }
        });
    }
    subscribe(changed: () => void): () => void {
        if (this.closed) throw new FSError('ECAPABILITY', 'Document chat file view is closed');
        const stops = [this.services.sessionRepository.subscribe(changed), this.services.sessionManager.onGlobalEvent(changed), this.services.kernel.kernel.onChanged(changed)];
        let active = true; const stop = () => {if (active) {active = false; stops.forEach(close => close()); this.stops.delete(stop);}};
        this.stops.add(stop); return stop;
    }
    async dispose(): Promise<void> {this.closed = true; this.stops.forEach(stop => stop()); this.stops.clear();}
}
