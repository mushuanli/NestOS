import {t, createModuleLogger} from '@itookit/common';
import {SessionCommand, assistantResponseText, type Round, type SessionInstructionQueue} from '@itookit/llm-session/contracts';
import type {ApplicationBackend, LocalApplicationServices} from '@itookit/app-contracts/services';

type Request = Parameters<ApplicationBackend['generateText']>[0];
const failure = (code: string) => Object.assign(new Error(code), {code});
/** Uses the ordinary durable submission path and observes only this operation's round. */
export async function generateInSession(services: LocalApplicationServices, request: Request, connectionId: string,
    modelName: string, signal: AbortSignal): Promise<string> {
    if (!services.acquireConversation) throw failure('TEXT_SESSION_UNAVAILABLE');
    const lease = await services.acquireConversation(request.sessionId);
    try {
        signal.throwIfAborted();
        await lease.commandBus.execute('vcs.branch.switch', {branchName: 'main'});
        await lease.commandBus.execute(SessionCommand.Submit, {
            expectedSessionId: request.sessionId, expectedBranch: 'main', target: {kind: 'agent', id: 'default'},
            source: {kind: 'composer', text: [`${t('textGeneration.instructions')}\n${request.prompt}\n\n${t('textGeneration.source')}\n${request.source}`, request.previousDraft && `${t('textGeneration.previousDraft')}\n${request.previousDraft}`].filter(Boolean).join('\n\n'), values: {}, attachments: []},
            submission: {id: request.operationId, source: {kind: 'text-generation', ownerId: request.sessionId, id: request.operationId}},
            overrides: {connectionId, modelName, executionMode: 'chat', webSearchEnabled: false}, historyPolicy: 'none',
        });
        return await observe(services, request, signal, lease.commandBus);
    } finally {await lease.dispose();}
}

function observe(services: LocalApplicationServices, request: Request, signal: AbortSignal,
    commands: import('@itookit/llm-session/contracts').ICommandBus): Promise<string> {
    return new Promise((resolve, reject) => {new TextSessionObserver(services, request, signal, commands, resolve, reject).start();});
}
class TextSessionObserver {
    private checking = false;
    private again = false;
    private finished = false;
    private roundId?: string;
    private unsubscribe = () => {};
    private timer?: ReturnType<typeof setInterval>;
    constructor(private services: LocalApplicationServices, private request: Request, private signal: AbortSignal,
        private commands: import('@itookit/llm-session/contracts').ICommandBus,
        private resolve: (content: string) => void, private reject: (error: unknown) => void) {}
    start(): void {
        this.unsubscribe = this.services.sessionRepository.subscribe(change => {
            if (!change?.sessionId || change.sessionId === this.request.sessionId) this.check();
        });
        this.timer = setInterval(this.check, 1000); this.signal.addEventListener('abort', this.check); this.check();
    }
    private finish = (error?: unknown, content?: string): void => {
        if (this.finished) return; this.finished = true; this.unsubscribe(); clearInterval(this.timer);
        this.signal.removeEventListener('abort', this.check); error ? this.reject(error) : this.resolve(content!);
    };
    private check = (): void => {
        if (this.finished) return; if (this.checking) {this.again = true; return;} this.checking = true;
        void this.inspect().catch(this.finish).finally(() => {this.checking = false; if (this.again) {this.again = false; this.check();}});
    };
    private async inspect(): Promise<void> {
        const repository = this.services.sessionRepository, {sessionId, operationId} = this.request;
        const round: Round | undefined = this.roundId ? JSON.parse(await repository.readDocument(sessionId, `round-${this.roundId}.json`) ?? 'null')
            : (await repository.readHistoryChain?.(sessionId))?.rounds.find(item => item.submission?.id === operationId);
        if (round) this.roundId = round.id;
        const queue = await this.commands.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        const queued = queue.items.find(item => item.id === operationId);
        if (this.signal.aborted) {await this.cancel(queue, round); return;}
        if (queued?.state === 'failed' || queued?.state === 'uncertain') throw failure('TEXT_SESSION_FAILED');
        if (!round || !['completed', 'failed', 'cancelled'].includes(round.status)) return;
        this.finish(undefined, completedText(round));
    }
    private async cancel(queue: SessionInstructionQueue, round?: Round): Promise<void> {
        const queued = queue.items.find(item => item.id === this.request.operationId);
        const executions = round?.executions ?? [];
        if (queued?.state === 'dispatching' && !executions.length) return;
        if (queued && queued.state !== 'dispatching') {
            try {await this.commands.execute(SessionCommand.EditInstructionQueue, {action: 'remove', id: queued.id, expectedRevision: queue.revision});}
            catch (error) {if ((error as {code?: string}).code === 'QUEUE_CONFLICT') return; throw error;}
        }
        for (const execution of executions) await this.services.kernel.kernel.cancel(this.request.sessionId, execution.taskId, 'Text generation cancelled');
        if (queued || round?.executions.length || (round && ['completed', 'failed', 'cancelled'].includes(round.status))) this.finish(failure('TEXT_CANCELLED'));
    }
}
function completedText(round: Round): string {
    if (round.status !== 'completed') throw failure(round.status === 'cancelled' ? 'TEXT_CANCELLED' : 'TEXT_SESSION_FAILED');
    const content = assistantResponseText(round);
    const finishReason = round.result?.finishReason;
    const metadata = {operationId: round.submission?.id, roundId: round.id, stage: 'output', result: content ? 'available' : 'empty', finishReason, outputCharacters: content.length};
    if (finishReason === 'length') createModuleLogger('text-generation').warn('text.output', metadata);
    if (!content) throw failure('TEXT_OUTPUT_EMPTY'); return content;
}
