import {resolveChatModelTiers} from '@itookit/kernel-adapters/contracts';
import {chatFollowups} from './chat-followups';
import {createAgentSendIntent} from '@itookit/llm-flow/contracts';
import {createModuleLogger, randomUUID, t} from '@itookit/common';
import {Toast, showConfirmDialog} from '@itookit/ui-common';
import {composeCommandCatalogs, type ChatView, type CommandSubmission, type OperationContext, type OperationReceipt, type OperationLedger, type ConversationSnapshot, type ComposerDraft, type ChatSubmission} from '@itookit/llm-ui';
import {SessionCommand, type SessionViewPort} from '@itookit/llm-session/contracts';
import type {LLMEditorOptions} from './session-editor-options';
import {createSlashCommandCatalog} from '../components/input/plugins/slash-command-catalog';
import type {SlashCommandCallbacks, SlashCommandDef} from '../components/input/plugins/SlashCommandPlugin';
import type {InputPluginContext} from '../components/input/plugins/InputPlugin';
import {bindSkillRefresh} from './skill-refresh';
import {SkillPanel} from '../components/input/SkillPanel';
import {parseSkillArgs, buildActionSkillMessage, buildSkillPrompt} from '../components/input/SkillInvocationParser';
import type {SkillInfo} from '../domain/types';
import {invokeFlowText} from '../flows/invoke-flow';
import {parseDirectoryCommand} from './directory-command';
import {prepareToolInvocation} from '../flows/invoke-tool';
import {ToolCommandOperations} from '../flows/tool-operations';
import type {RunAttachmentCallbacks} from './RunAttachmentController';
import {RunAttachmentController} from './RunAttachmentController';
import {rememberTaskAttachment, restoreTaskAttachment} from './task-attachment-lifecycle';
import {parseDirectCommand} from '../commands/direct-command';

interface Options {
    config: LLMEditorOptions; session: SessionViewPort; operations: OperationLedger; signal: AbortSignal;
    view(): ChatView | undefined; snapshot(): ConversationSnapshot; current(): boolean;
    taskCallbacks: RunAttachmentCallbacks;
    attach(controller: RunAttachmentController): void;
    changed(): Promise<void>; selectAgent(id: string): Promise<void>; configure(values: Record<string, string>): Promise<void>;
    openSettings(): void;
    report(error: unknown): void;
}
/** Product commands keep their policy here; the shared composer supplies discovery and durable dispatch. */
export class SharedChatCommands {
    private closing?: Promise<void>;
    private readonly definitions: SlashCommandDef[];
    private skills: SkillInfo[] = [];
    private skillsPanel?: SkillPanel;
    private skillRoot?: HTMLDetailsElement;
    private skillBinding?: ReturnType<typeof bindSkillRefresh>;
    private readonly listeners = new Set<() => void>();
    private readonly attachment?: RunAttachmentController;
    constructor(private readonly options: Options) {
        if (options.config.sessionSkills) this.skillBinding = bindSkillRefresh(options.config.sessionSkills, options.config.sessionId, skills => {
            this.skills = skills; this.skillsPanel?.refresh(skills); for (const listener of this.listeners) listener();
        });
        this.definitions = createSlashCommandCatalog(this.callbacks(), name => {throw new Error(`${name}: ${t('toolbox.unavailable')}`);});
        if (options.config.kernel) {
            this.attachment = new RunAttachmentController(options.config.kernel, options.taskCallbacks);
            options.attach(this.attachment);
        }
    }
    getSnapshot() {
        return composeCommandCatalogs([{source: {id: 'nestos', label: 'NestOS'}, commands: [...this.definitions, ...this.skillCommands()].flatMap(item =>
            [item.name, ...item.aliases ?? []].map(name => ({id: name, name, revision: 0, description: item.description, kind: 'action' as const, ...(item.name === 'run' ? {dispatch: 'send' as const} : {}),
                argumentHint: item.argsPlaceholder})))}]);
    }
    async execute(input: CommandSubmission, context: OperationContext): Promise<OperationReceipt> {
        this.check(); const name = this.getSnapshot().find(item => item.id === input.target.id)?.commandId ?? '';
        const definitions = createSlashCommandCatalog(this.callbacks(context), name => {throw new Error(`${name}: ${t('toolbox.unavailable')}`);});
        const command = [...definitions, ...this.skillCommands()].find(item => item.name === name || item.aliases?.includes(name));
        if (!command || input.target.expectedRevision !== 0) return {status: 'rejected', operationId: context.operationId, code: 'STALE_COMMAND', message: t('slash.error.failed', {name})};
        if (command.name === 'run') return {status: 'rejected', operationId: context.operationId, code: 'MESSAGE_SUBMISSION_REQUIRED', message: t('harness.commandUnavailable')};
        try {await command.execute(input.arguments, this.context());}
        catch (error) {
            const code = (error as {code?: string})?.code;
            if (!code || !['INVALID_HISTORY_LENGTH', 'MODEL_SELECTION_UNAVAILABLE'].includes(code)) throw error;
            return {status: 'rejected', operationId: context.operationId, code, message: (error as Error).message};
        }
        return {status: 'accepted', operationId: context.operationId};
    }
    async direct(input: ChatSubmission, draft: ComposerDraft): Promise<boolean> {
        const command = parseDirectCommand(input.text, input.attachments); if (command === undefined) return false;
        this.check(); if (!this.options.config.privilegedCommands || !this.attachment) throw new Error(t('chatInput.command.unavailable'));
        const ledger = this.options.operations;
        if (ledger.getSnapshot().some(record => ['unknown', 'submitting'].includes(record.status) && (record.input as {protocol?: string})?.protocol === 'direct-command'))
            throw new Error(t('chat.submission.unconfirmed'));
        const operationId = randomUUID(), viewId = this.options.snapshot().viewId;
        await ledger.register({context: {operationId, viewId}, conversationId: this.options.config.sessionId, kind: 'command', status: 'submitting',
            input: {protocol: 'direct-command', command}});
        try {
            await this.exec(command); await ledger.settle({operationId, status: 'accepted'});
            const current = this.view().getDraft();
            if (current.scopeId === draft.scopeId && current.textRevision === draft.textRevision && current.text === draft.text) this.view().setText('');
        } catch (error) {await ledger.settle({operationId, status: 'unknown', message: t('chat.submission.unconfirmed')}); throw error;}
        return true;
    }
    private callbacks(context?: OperationContext): SlashCommandCallbacks {
        return {...this.chatCallbacks(context), ...this.viewCallbacks(), ...this.branchCallbacks(), ...this.configurationCallbacks(), ...this.taskCommands()};
    }
    private chatCallbacks(context?: OperationContext): Pick<SlashCommandCallbacks, 'onNew' | 'onRetry' | 'onClear' | 'onDeleteLast' | 'onReedit' | 'onBtw' | 'onShorter' | 'onLonger' | 'onSimplify' | 'onSummarize' | 'onContinue'> {
        const send = async (text: string) => {const view = this.view(); view.setText(text); await view.submit();};
        return {
            onNew: title => {if (!this.options.config.hostContext?.navigate) throw new Error(t('toolbox.unavailable')); return this.options.config.hostContext.navigate({target: 'chat', action: 'create', create: {title}});},
            onRetry: async () => {const item = this.last('assistant'), message = this.options.snapshot().messages.find(row => row.id === item?.id);
                if (message) await this.view().retryMessage({messageId: message.id, expectedRevision: message.revision});},
            onClear: async () => {if (await showConfirmDialog(t('slash.clear.description'))) {this.check(); await this.options.config.commandBus!.execute(SessionCommand.DeleteMessages, {messageIds: this.options.session.getSessions().map(item => item.id)});}},
            onDeleteLast: async () => {const item = this.last('user'); if (item && await showConfirmDialog(t('slash.delete.description'))) {
                this.check(); await this.options.config.commandBus!.execute(SessionCommand.DeleteMessage, {messageId: item.id, options: {deleteAssociatedResponses: true}});}},
            onReedit: async () => {const item = this.last('user'); if (!item) return; this.check();
                await this.options.config.commandBus!.execute(SessionCommand.DeleteMessage, {messageId: item.id, options: {deleteAssociatedResponses: true}}); this.view().setText(item.content ?? '');},
            onBtw: text => this.aside(text, context), onShorter: () => send(chatFollowups.shorter), onLonger: () => send(chatFollowups.longer),
            onSimplify: () => send(chatFollowups.simplify), onSummarize: () => send(chatFollowups.summarize), onContinue: () => send(chatFollowups.continue),
        };
    }
    private viewCallbacks(): Pick<SlashCommandCallbacks, 'onHistory' | 'onFresh' | 'onFoldCurrent' | 'onFoldAll' | 'onUnfoldAll' | 'onTop' | 'onBottom' | 'onNav' | 'onExport' | 'onCopyAll' | 'onPrint'> {
        return {onHistory: length => {const value = Number(length); if (!length.trim() || !Number.isSafeInteger(value) || value < -1) throw Object.assign(new Error(t('slash.history.invalid')), {code: 'INVALID_HISTORY_LENGTH'}); return this.options.configure({historyLength: String(value)});}, onFresh: () => this.options.configure({historyLength: '0'}),
            onFoldCurrent: () => this.view().collapseCurrent(), onFoldAll: () => this.view().setAllCollapsed(true), onUnfoldAll: () => this.view().setAllCollapsed(false),
            onTop: () => this.view().scrollHistory('start'), onBottom: () => this.view().scrollHistory('end'), onNav: () => this.view().openPrompts(),
            onExport: () => this.copy(), onCopyAll: () => this.copy(), onPrint: () => this.view().print()};
    }
    private branchCallbacks(): Pick<SlashCommandCallbacks, 'onCreateBranch' | 'onSwitchBranch' | 'onBranchPrev' | 'onBranchNext' | 'onListBranches' | 'onRenameBranch' | 'onDeleteBranch'> {
        return {onCreateBranch: async () => {const item = this.last(); if (item) await this.branch('vcs.branch.create', {branchNodeId: item.id, options: {}});},
            onSwitchBranch: name => this.branch('vcs.branch.switch', {branchName: name}), onBranchPrev: () => this.offset(-1), onBranchNext: () => this.offset(1),
            onListBranches: async () => {const manifest = await this.options.config.sessionRepository.getManifest(this.options.config.sessionId); Toast.info(Object.keys(manifest.branches).join('\n'));},
            onRenameBranch: args => {const [oldName, newName] = args.trim().split(/\s+/, 2); return this.branch('vcs.branch.rename', {oldName, newName});},
            onDeleteBranch: branchName => this.branch('vcs.branch.delete', {branchName})};
    }
    private configurationCallbacks(): Pick<SlashCommandCallbacks, 'onSwitchAgent' | 'onConnection' | 'onModel' | 'onHelp' | 'getSkills' | 'onSkill' | 'onSkills'> {
        return {onSwitchAgent: id => this.options.selectAgent(id), onConnection: args => args.trim() ? this.options.configure({connectionId: args.trim() === '--reset' ? '' : args.trim()}) : this.options.openSettings(),
            onModel: model => this.selectModel(model), onHelp: () => Toast.info(this.definitions.map(item => `/${item.name}: ${item.description}`).join('\n')),
            ...(this.options.config.sessionSkills ? {getSkills: () => this.skills, onSkill: async (id: string) => {this.check(); await this.options.config.sessionSkills!.load(this.options.config.sessionId, id);},
                onSkills: () => {if (this.skillRoot) this.skillRoot.open = true;}} : {})};
    }
    private taskCommands(): Pick<SlashCommandCallbacks, 'onFlow' | 'onAddDirectory' | 'onSetHome' | 'onPlan' | 'onExec' | 'onCancelTask' | 'onResumeTask' | 'onApproveTask' | 'onTool'> {
        return {onFlow: args => invokeFlowText(this.options.config.commandBus!, this.options.config.sessionId, args, this.options.signal,
            id => this.options.config.hostContext?.navigate({target: 'chat', resourceId: id}), this.options.operations),
            onAddDirectory: args => this.directory(args, false), onSetHome: args => this.directory(args, true),
            ...(this.options.config.privilegedCommands && this.options.config.kernel ? {onPlan: goal => this.plan(goal), onExec: command => this.exec(command),
                onCancelTask: () => this.requireAttachment().cancel(), onResumeTask: () => this.requireAttachment().resume(), onApproveTask: note => this.requireAttachment().approve(note),
                ...(this.options.config.privilegedCommands.tool ? {onTool: (args: string, mcpOnly: boolean) => this.tool(args, mcpOnly)} : {})} : {})};
    }
    private last(role?: string) {return [...this.options.session.getSessions()].reverse().find(item => !role || item.role === role);}
    private requireAttachment(): RunAttachmentController {this.check(); if (!this.attachment) throw new Error(t('toolbox.unavailable')); return this.attachment;}
    private async selectModel(model: string): Promise<void> {
        this.check(); const requested = model.trim();
        if (['auto', 'optimal', 'standard', 'fast'].includes(requested)) return this.options.configure({modelTier: requested});
        const service = this.options.config.agentService, draft = this.view().getDraft();
        const [connections, fallback] = await Promise.all([service.getConnections(), service.getDefaultConnection()]); this.check();
        const preferred = draft.selection?.connectionId || service.findAgent(draft.target?.id ?? '')?.modelDefaults?.chat || fallback?.id;
        const connection = connections.find(item => item.id === preferred);
        const models = connection ? resolveChatModelTiers(connection, service.getProvider(connection.providerId)) : {};
        const tier = Object.entries(models).find(([, value]) => value?.id === requested)?.[0];
        if (!connection || !tier) throw Object.assign(new Error(t('slash.model.unavailable')), {code: 'MODEL_SELECTION_UNAVAILABLE'});
        if (this.view().getDraft().revision !== draft.revision) throw Object.assign(new Error(t('chatInput.switchUnavailable')), {code: 'MODEL_SELECTION_UNAVAILABLE'});
        await this.options.configure({connectionId: connection.id, modelTier: tier});
    }
    private async aside(text: string, context?: OperationContext): Promise<void> {
        this.check(); if (!context || !text.trim()) throw new Error(t('harness.commandUnavailable'));
        const agentId = this.view().getDraft().target?.kind === 'agent' ? this.view().getDraft().target!.id : undefined;
        if (!agentId) throw new Error(t('callable.catalog.changed'));
        await this.options.config.commandBus!.execute(SessionCommand.Send, {text: text.trim(), files: [], agentId, origin: 'user', historyPolicy: 'exclude', overrides: {historyLength: 0},
            sendIntent: {...createAgentSendIntent(agentId), submission: {id: context.operationId, source: {kind: 'conversation', ownerId: this.options.config.sessionId, id: context.operationId}}}});
    }
    subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
    mountSkills(container: HTMLElement): void {
        const controls = this.options.config.sessionSkills; if (!controls) return;
        const details = this.skillRoot = document.createElement('details'), summary = document.createElement('summary');
        const section = document.createElement('section'), list = document.createElement('div');
        details.className = 'llm-chat__host-menu'; summary.textContent = t('chatSettings.skills'); section.className = 'llm-input__skill-section'; list.className = 'llm-input__skills-list';
        section.append(list); details.append(summary, section); container.append(details);
        this.skillsPanel = new SkillPanel(details, {onRequestSkills: () => controls.list(this.options.config.sessionId),
            onLoadSkill: async id => {this.check(); return controls.load(this.options.config.sessionId, id);},
            onUnloadSkill: async id => {this.check(); await controls.unload(this.options.config.sessionId, id);}});
        this.skillsPanel.refresh(this.skills);
    }
    private skillCommands(): SlashCommandDef[] {
        return this.skills.filter(skill => skill.definitionEnabled).map(skill => ({name: `sk-${skill.id}`, label: `/sk-${skill.id}`,
            description: skill.description ?? skill.name, hasArgs: true, execute: async args => {
                const controls = this.options.config.sessionSkills!, revision = this.view().getDraft().revision;
                const invocation = parseSkillArgs(skill.id, args), definition = await controls.describe(this.options.config.sessionId, skill.id);
                this.check(); if (!definition?.enabled) throw new Error(t('slash.error.skillUnavailable'));
                const direct = definition.triggerStrategy === 'action' || definition.disableModelInvocation;
                if (!direct) await controls.load(this.options.config.sessionId, skill.id);
                if (this.view().getDraft().revision !== revision) throw Object.assign(new Error('Input changed during Skill preparation'), {code: 'DRAFT_REVISION_CONFLICT'});
                this.view().setText(direct ? buildActionSkillMessage(invocation, definition.instructions) : buildSkillPrompt(invocation, definition.name, definition.type));
                await this.view().submit();
            }}));
    }
    private context(): InputPluginContext {
        return {...this.view().inputContext(), getAgentId: () => this.view().getDraft().target?.id ?? 'default'};
    }
    private async branch(command: string, args: unknown): Promise<void> {this.check(); await this.view().flushDraft(); this.check(); await this.options.config.commandBus!.execute(command, args); await this.options.changed();}
    private async offset(offset: number): Promise<void> {
        const manifest = await this.options.config.sessionRepository.getManifest(this.options.config.sessionId), names = Object.keys(manifest.branches);
        if (names.length > 1) await this.branch('vcs.branch.switch', {branchName: names[(names.indexOf(manifest.currentBranch) + offset + names.length) % names.length]});
    }
    private async directory(args: string, home: boolean): Promise<void> {
        const command = parseDirectoryCommand(args), port = this.options.config.hostContext?.directoryCommands; if (!port) throw new Error(t('toolbox.unavailable'));
        this.check(); const result = home ? await port.setHome(command.directory) : await port.addDirectory(command.directory, command.access); Toast.info(result);
    }
    private async copy(): Promise<void> {await navigator.clipboard.writeText(await this.options.config.commandBus!.execute<string>(SessionCommand.Export));}
    private async exec(command: string): Promise<void> {this.check(); if (!this.options.config.privilegedCommands || !this.attachment) throw new Error(t('chatInput.command.unavailable'));
        await this.remember(await this.options.config.privilegedCommands.exec({sessionId: this.options.config.sessionId, command}));}
    private async plan(goal: string): Promise<void> {this.check(); if (!this.options.config.privilegedCommands || !this.attachment) throw new Error(t('toolbox.unavailable'));
        await this.remember(await this.options.config.privilegedCommands.plan({sessionId: this.options.config.sessionId, goal,
            agentId: this.view().getDraft().target?.id ?? 'default', connectionId: this.view().getDraft().selection?.connectionId || undefined}));}
    private async tool(text: string, mcpOnly: boolean): Promise<boolean> {
        this.check(); const service = this.options.config.privilegedCommands!;
        const value = await prepareToolInvocation(service, this.options.config.sessionId, text, this.options.signal, mcpOnly);
        if (!value || this.options.signal.aborted) return false;
        const taskId = await new ToolCommandOperations(this.options.operations, service).submit({sessionId: this.options.config.sessionId, ...value});
        await this.remember(taskId); return true;
    }
    private async remember(taskId: string): Promise<void> {
        this.check(); await rememberTaskAttachment(this.options.config.kernel!, this.options.config.sessionId, this.attachment!, taskId);
        createModuleLogger('shared-chat-commands').info('chat.task.attach', {operationId: randomUUID(), stage: 'commit', result: 'success', taskId});
    }
    async restore(): Promise<void> {if (this.attachment) await restoreTaskAttachment(this.options.config.kernel!, this.options.config.sessionId, this.attachment,
        () => this.options.current(), async () => new Set(), this.options.config.readTaskAttachment);}
    private check(): void {this.options.signal.throwIfAborted(); if (!this.options.current()) throw Object.assign(new Error('Chat command binding expired'), {code: 'STALE_VIEW'});}
    private view(): ChatView {this.check(); const view = this.options.view(); if (!view) throw new Error('ChatView is not ready'); return view;}
    destroy(): Promise<void> {return this.closing ??= this.dispose();}
    private async dispose(): Promise<void> {this.skillBinding?.dispose(); this.skillRoot?.remove(); this.listeners.clear(); await this.attachment?.detach();}
}
