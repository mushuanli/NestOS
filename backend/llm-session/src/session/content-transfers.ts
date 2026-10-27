import type { Kernel, JsonValue } from '@itookit/durable-kernel';
import type { ICommandBus } from '../contracts';
import { ContentTransferCommand, isTransferSelection, type ContentCapture, type ContentTransfer, type CreateChildInput, type ChildCreationReceipt, type ResolveTransferInput, type TransferReference } from '../contracts/content-transfer';
import type { ISessionRepository } from '../persistence/types';
import { ulid } from '../persistence/ulid';
import { createSessionHost, type SessionHostPorts } from '../utils/host-ports';
import { captureContent, selectedMessages, transferText } from './content-capture';
import {ChildSessionCreation} from './child-session-creation';

export interface ContentTransferOptions {
    kernel: Kernel; repository: ISessionRepository; commands: ICommandBus; hostPorts?: SessionHostPorts;
    canWrite?(sessionId: string): Promise<boolean>;
    /** Bootstrap execution storage under the host's metadata lease before its recovery gate. */
    prepareExecution?(sessionId: string): Promise<void>;
    summarize?(sessionId: string, text: string): Promise<string>;
}

const captureKey = (id: string) => `content.capture.${id}`;
const transferKey = (id: string) => `content.transfer.${id}`;

/** Immutable source snapshots and explicit transfers, independent of conversation ancestry. */
export class ContentTransferService {
    private readonly host;
    private readonly children: ChildSessionCreation;
    constructor(private readonly options: ContentTransferOptions) {
        this.host = createSessionHost(options.hostPorts);
        this.children = new ChildSessionCreation({...options, writable: id => this.writable(id), readTransfer: (ref, id) => this.read(ref, id)});
    }
    register(): void {
        const commands = this.options.commands;
        commands.register(ContentTransferCommand.Capture, args => this.trace('capture', String((args as { sessionId: string }).sessionId), () => this.capture(String((args as { sessionId: string }).sessionId))));
        commands.register(ContentTransferCommand.Resolve, args => this.trace('resolve', (args as ResolveTransferInput).sessionId, () => this.resolve(args as ResolveTransferInput)));
        commands.register(ContentTransferCommand.CreateChild, args => this.createChild(args as CreateChildInput));
        commands.register(ContentTransferCommand.ChildReceipt, args => this.inspectChild(args as CreateChildInput));
    }

    async capture(sessionId: string): Promise<ContentCapture> {
        await this.writable(sessionId);
        const captured = await captureContent(this.options.repository, this.options.commands, sessionId, this.options.kernel);
        await (await this.options.kernel.openSession(sessionId)).setShared(captureKey(captured.id), json(captured), { expectedVersion: null });
        return captured;
    }

    async resolve(input: ResolveTransferInput): Promise<ContentTransfer> {
        if (!isTransferSelection(input.selection)) throw new Error('CONTENT_SELECTION_INVALID');
        await this.writable(input.sessionId);
        const session = await this.options.kernel.openSession(input.sessionId);
        const capture = (await session.getShared(captureKey(input.captureId)))?.value as unknown as ContentCapture | undefined;
        if (!capture || capture.sessionId !== input.sessionId) throw new Error('CONTENT_CAPTURE_NOT_FOUND');
        const messages = selectedMessages(capture, input.selection);
        const value = await this.value(capture, input, transferText(messages));
        if (value === '' || value === undefined) throw new Error('CONTENT_SOURCE_EMPTY');
        const transfer: ContentTransfer = { id: ulid(), sessionId: input.sessionId, captureId: capture.id,
            branch: capture.branch, head: capture.head, createdAt: Date.now(), selection: structuredClone(input.selection),
            messageIds: messages.map(item => item.id), value };
        if (input.selection.kind === 'output') {
            const id = input.selection.outputId, output = capture.outputs.find(item => item.id === id)!;
            const {value: _value, ...origin} = output; transfer.output = origin;
        }
        await session.setShared(transferKey(transfer.id), json(transfer), { expectedVersion: null });
        return transfer;
    }

    async read(reference: TransferReference, targetSessionId: string): Promise<ContentTransfer> {
        if (!reference || typeof reference.sessionId !== 'string' || typeof reference.id !== 'string') throw new Error('CONTENT_TRANSFER_NOT_FOUND');
        if (reference.sessionId !== targetSessionId) {
            const target = await this.options.repository.getManifest(targetSessionId);
            if (target.parentSessionId !== reference.sessionId) throw new Error('CONTENT_SOURCE_OUTSIDE_SESSION');
        }
        const session = await this.options.kernel.inspectSession(reference.sessionId);
        const transfer = (await session.getShared(transferKey(reference.id)))?.value as unknown as ContentTransfer | undefined;
        if (!transfer || transfer.sessionId !== reference.sessionId) throw new Error('CONTENT_TRANSFER_NOT_FOUND');
        return structuredClone(transfer);
    }

    createChild(input: CreateChildInput): Promise<{sessionId: string}> {return this.children.create(input);}
    inspectChild(input: CreateChildInput): Promise<ChildCreationReceipt> {return this.children.inspect(input);}

    private async value(capture: ContentCapture, input: ResolveTransferInput, text: string): Promise<JsonValue> {
        if (input.selection.kind === 'text') {
            if (typeof input.selection.text !== 'string' || !input.selection.text.trim()) throw new Error('CONTENT_SOURCE_EMPTY');
            return input.selection.text;
        }
        if (input.selection.kind === 'output') {
            const outputId = input.selection.outputId;
            const output = capture.outputs.find(item => item.id === outputId);
            if (!output) throw new Error('CONTENT_OUTPUT_NOT_FOUND');
            return output.value;
        }
        if (input.selection.kind !== 'summary') return text;
        if (!text) throw new Error('CONTENT_SOURCE_EMPTY');
        if (!this.options.summarize) throw new Error('CONTENT_SUMMARIZER_UNAVAILABLE');
        const summary = await this.trace('summarize', input.sessionId, () => this.options.summarize!(input.sessionId, text));
        if (!summary?.trim()) throw new Error('CONTENT_SUMMARY_EMPTY');
        return summary.trim();
    }

    private async writable(sessionId: string): Promise<void> {
        if (this.options.canWrite && !await this.options.canWrite(sessionId)) throw new Error('CONTENT_SESSION_READ_ONLY');
        const stat = await this.options.kernel.sessionStat(sessionId);
        if (stat.phase !== 'open' || stat.archived) throw new Error('CONTENT_SESSION_CLOSED');
    }

    private async trace<T>(stage: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
        const started = Date.now(), operationId = ulid();
        try {
            const result = await operation();
            this.host.logger.info('Content transfer', { operation: 'content.transfer', stage, sessionId, operationId, outcome: 'success', durationMs: Date.now() - started });
            return result;
        } catch (error) {
            const code = error instanceof Error && /^CONTENT_[A-Z_]+$/.test(error.message) ? error.message : 'CONTENT_OPERATION_FAILED';
            this.host.logger.error('Content transfer', { operation: 'content.transfer', stage, sessionId, operationId, outcome: 'failure', errorCode: code,
                errorClass: error instanceof Error ? error.name : typeof error, durationMs: Date.now() - started });
            throw error;
        }
    }
}
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)); }
