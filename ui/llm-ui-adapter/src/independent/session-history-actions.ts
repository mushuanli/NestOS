import {rerunSessionFlow, type FlowRerunContext} from '../flows/rerun-flow';
import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {SessionCommand, type ICommandBus, type SessionViewPort, type SessionGroup} from '@itookit/llm-session/contracts';
import type {ConversationSnapshot, MessageTarget, OperationContext, OperationReceipt, MessageAction, RenderContext} from '@itookit/llm-ui';

interface Options {
    commands: ICommandBus; session: SessionViewPort;
    snapshot(): ConversationSnapshot;
    available(): boolean;
    changed(): Promise<void>;
}
/** Validate the captured display identity before invoking existing Session history commands. */
export class SessionHistoryActions {
    private rerunAbort?: AbortController;
    constructor(private readonly options: Options) {}
    setActive(active: boolean): void {if (!active) this.rerunAbort?.abort();}
    destroy(): void {this.rerunAbort?.abort();}
    readonly actions = {
        edit: (target: MessageTarget, text: string, context: OperationContext) => this.receipt(target, context, SessionCommand.CanEdit,
            async group => {await this.options.commands.execute(SessionCommand.CommitEdit, {messageId: group.id, newContent: text, autoRerun: true});}),
        retry: (target: MessageTarget, context: OperationContext) => this.receipt(target, context, SessionCommand.CanRegenerate,
            async group => {if (group.callInput?.admitted) {await this.rerun(group, target, context.viewId); return;} await this.options.commands.execute(group.role === 'user' ? SessionCommand.RegenerateFromUser : SessionCommand.Regenerate,
                group.role === 'user' ? {userMessageId: group.id} : {assistantId: group.id});}),
    };
    messageActions({message, snapshot}: RenderContext): MessageAction[] {
        if (!this.options.available() || message.role !== 'user') return [];
        const target = {messageId: message.id, expectedRevision: message.revision};
        const group = this.options.session.getSessions().find(item => item.id === message.id || `${item.id}:input:${(item.inputMessages?.length ?? 1) - 1}` === message.id);
        if (!group) return [];
        return [
            ...(group.callInput?.admitted ? [{id: 'rerun-arguments', label: t('flow.rerun.title'), run: () => this.run(target, snapshot.viewId, undefined, group => this.rerun(group, target, snapshot.viewId))}] : []),
            {id: 'branch', label: t('branch.continue'), run: () => this.run(target, snapshot.viewId, undefined,
                async group => {await this.options.commands.execute('vcs.branch.create', {branchNodeId: group.id, options: {}});})},
            {id: 'delete', placement: 'more', label: t('action.delete'), run: () => this.run(target, snapshot.viewId, SessionCommand.CanDelete,
                async group => {await this.options.commands.execute(SessionCommand.DeleteMessage, {messageId: group.id, options: {deleteAssociatedResponses: true}});})},
        ];
    }
    private async rerun(group: SessionGroup, target: MessageTarget, viewId: string): Promise<void> {
        if (!group.roundId) throw new Error(t('flow.rerun.unavailable'));
        this.rerunAbort?.abort(); const abort = this.rerunAbort = new AbortController();
        const context = await this.options.commands.execute<FlowRerunContext>(SessionCommand.FlowRerunContext, {sourceRoundId: group.roundId});
        abort.signal.throwIfAborted(); this.resolve(target, viewId);
        await rerunSessionFlow(this.options.commands, abort.signal, context);
    }
    private resolve(target: MessageTarget, viewId: string): SessionGroup {
        const snapshot = this.options.snapshot();
        if (!this.options.available() || snapshot.viewId !== viewId || !snapshot.messages.some(message => message.id === target.messageId && message.revision === target.expectedRevision))
            throw Object.assign(new Error('History changed; refresh before applying this action'), {code: 'HISTORY_REVISION_CONFLICT'});
        const group = this.options.session.getSessions().find(item => item.id === target.messageId || `${item.id}:input:${(item.inputMessages?.length ?? 1) - 1}` === target.messageId);
        if (!group) throw Object.assign(new Error('History target no longer exists'), {code: 'HISTORY_TARGET_MISSING'});
        return group;
    }
    private async run(target: MessageTarget, viewId: string, check: string | undefined, apply: (group: SessionGroup) => Promise<void>, operationId = randomUUID()): Promise<void> {
        const started = Date.now(); let stage = 'validate';
        try {
            const group = this.resolve(target, viewId);
            if (check) {
                const permission = await this.options.commands.execute<{allowed: boolean; reason?: string}>(check, {messageId: group.id});
                if (!permission.allowed) throw Object.assign(new Error(permission.reason ?? t('branch.unavailable')), {code: 'HISTORY_ACTION_DENIED'});
            }
            this.resolve(target, viewId); stage = 'dispatch'; await apply(group); stage = 'observe'; await this.options.changed();
            report(operationId, stage, started);
        } catch (error) {report(operationId, stage, started, error); throw error;}
    }
    private async receipt(target: MessageTarget, context: OperationContext, check: string, apply: (group: SessionGroup) => Promise<void>): Promise<OperationReceipt> {
        try {await this.run(target, context.viewId, check, apply, context.operationId); return {status: 'accepted', operationId: context.operationId};}
        catch (error) {
            const code = (error as {code?: string})?.code;
            if (!code || !['HISTORY_REVISION_CONFLICT', 'HISTORY_TARGET_MISSING', 'HISTORY_ACTION_DENIED'].includes(code)) throw error;
            return {status: 'rejected', operationId: context.operationId, code, message: error instanceof Error ? error.message : t('branch.unavailable')};
        }
    }
}
function report(operationId: string, stage: string, started: number, error?: unknown): void {
    const raw = (error as {code?: unknown})?.code;
    const data = {operationId, stage, result: error ? 'failure' : 'success', durationMs: Date.now() - started,
        code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : error ? 'HISTORY_ACTION_FAILED' : undefined};
    const log = createModuleLogger('session-history-actions'); if (error) log.warn('chat.history', data); else log.info('chat.history', data);
}
