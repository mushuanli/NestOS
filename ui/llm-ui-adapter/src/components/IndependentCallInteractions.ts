import {InteractionDraftEditor} from '../services/InteractionDraftEditor';
import type {InteractionDraftStorage, InteractionDraftRecord} from '../domain/interaction-draft';
import {createInteractionCard, type InteractionCard, type InteractionResponse, type InputField, type OperationRecord} from '@itookit/llm-ui';
import {createModuleLogger, getLocale, randomUUID, t} from '@itookit/common';
import {IndependentCallCommand, type ICommandBus, type IndependentCallView, type IndependentCallResponseRequest,
    type IndependentCallResponseQuery, type IndependentCallInteractionDetail} from '@itookit/llm-session/contracts';
import {CallControlOperations, callControlErrorCode} from '../independent/call-control';
import {agentQuestionFields, agentQuestionAnswer} from './input/agent-questions';

interface Entry {element: HTMLElement; prompt: HTMLElement; button: HTMLButtonElement; status: HTMLElement; query: IndependentCallResponseQuery;
    draft?: InteractionDraftEditor; submittedDraft?: InteractionDraftRecord; retry?: HTMLButtonElement; frozen?: HTMLElement; error?: string; editor?: InteractionCard; mode?: HTMLSelectElement; loading?: boolean; reading?: boolean; generation: number}
const log = createModuleLogger('independent-call-interactions');
const keyOf = (value: {targetTaskId: string; interactionId: string}) => JSON.stringify([value.targetTaskId, value.interactionId]);
/** Stable interaction rows preserve edits during observation; answers use the original operation ledger. */
export class IndependentCallInteractions {
    private entries = new Map<string, Entry>();
    private active = true;
    private closed = false;
    private call?: IndependentCallView;
    constructor(private host: HTMLElement, private commands: ICommandBus, private controls: CallControlOperations, private refresh: () => void, private drafts?: InteractionDraftStorage) {}
    update(call: IndependentCallView): void {
        this.call = call;
        const records = this.records(), keep = new Set<string>();
        for (const item of call.controlCapabilities?.respond ? call.interactions?.items ?? [] : []) {
            const query = this.query(item.taskId, item.interactionId), key = keyOf(query); keep.add(key);
            this.entry(query).prompt.textContent = item.prompt + (item.promptTruncated ? '…' : '');
        }
        for (const record of records.filter(pending)) {
            const query = (record.input as unknown as {request: IndependentCallResponseRequest}).request;
            keep.add(keyOf(query)); this.entry(query);
        }
        for (const [key, entry] of this.entries) {
            if (!keep.has(key)) {this.dispose(entry); this.entries.delete(key); continue;}
            const record = [...records].reverse().find(record => keyOf((record.input as unknown as {request: IndependentCallResponseRequest}).request) === key);
            this.render(entry, record);
            if (record && pending(record) && this.active && !entry.reading) void this.read(entry, record);
        }
        this.host.hidden = !this.entries.size;
    }
    setActive(active: boolean): void {
        this.active = active;
        for (const entry of this.entries.values()) {entry.generation++; entry.loading = false; entry.reading = false;
            if (entry.retry) entry.retry.disabled = !active; entry.button.disabled = !active; entry.editor?.setPending(!active || !!this.record(entry));}
    }
    destroy(): void {this.closed = true; for (const entry of this.entries.values()) this.dispose(entry); this.entries.clear();}
    private records(): OperationRecord[] {
        const call = this.call;
        return call?.receipt.execution ? this.controls.answers(call.input.request.expectedBranch!, call.receipt.operationId, call.receipt.execution.taskId) : [];
    }
    private record(entry: Entry) {return [...this.records()].reverse().find(record => keyOf((record.input as unknown as {request: IndependentCallResponseRequest}).request) === keyOf(entry.query));}
    private query(targetTaskId: string, interactionId: string): IndependentCallResponseQuery {
        const previous = this.entries.get(keyOf({targetTaskId, interactionId})); if (previous) return previous.query;
        const call = this.call!;
        return {sessionId: call.receipt.callerSessionId, branchId: call.input.request.expectedBranch!, callId: call.receipt.operationId,
            executionSessionId: call.receipt.executionSessionId!, taskId: call.receipt.execution!.taskId, targetTaskId, interactionId, requestId: randomUUID()};
    }
    private entry(query: IndependentCallResponseQuery): Entry {
        const key = keyOf(query), previous = this.entries.get(key); if (previous) return previous;
        const element = document.createElement('section'), prompt = document.createElement('p'), button = document.createElement('button'), status = document.createElement('p');
        element.dataset.callAnswer = key; status.setAttribute('role', 'status'); button.type = 'button'; button.dataset.callAnswerAction = '';
        element.append(prompt, button, status); this.host.append(element);
        const {sessionId, branchId, callId, executionSessionId, taskId, targetTaskId, interactionId, requestId} = query;
        const entry = {element, prompt, button, status, query: {sessionId, branchId, callId, executionSessionId, taskId, targetTaskId, interactionId, requestId}, generation: 0}; this.entries.set(key, entry);
        button.onclick = () => {const record = this.record(entry); void (record && pending(record) ? this.read(entry, record) : this.load(entry));}; return entry;
    }
    private render(entry: Entry, record?: OperationRecord): void {
        this.renderFrozen(entry, record);
        entry.prompt.hidden = !!entry.editor;
        entry.button.textContent = t(record && pending(record) ? 'callable.independent.answer.query' : 'callable.independent.answer.open');
        entry.button.hidden = !!entry.editor && !record || record?.status === 'accepted';
        entry.button.disabled = !this.active || this.closed || !!entry.loading || !!entry.reading;
        entry.editor?.setPending(!this.active || !!record && record.status !== 'rejected');
        if (record && pending(record)) entry.status.textContent = t('callable.independent.answer.unknown');
        if (record?.status === 'accepted') entry.status.textContent = t('callable.independent.answer.accepted');
        if (entry.error) entry.status.textContent = entry.error;
        if (entry.mode) entry.mode.disabled = !this.active || !!record && record.status !== 'rejected';
    }
    private renderFrozen(entry: Entry, record?: OperationRecord): void {
        if (!record || entry.editor) return;
        if (!entry.frozen) {entry.frozen = document.createElement('pre'); entry.frozen.dataset.savedAnswer = ''; entry.element.append(entry.frozen);}
        const value = (record.input as unknown as {request: IndependentCallResponseRequest}).request.value;
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
        entry.frozen.textContent = t('callable.independent.answer.savedPreview') + '\n' + text.slice(0, 4096) + (text.length > 4096 ? '…' : '');
    }
    private current(entry: Entry, generation: number): boolean {return !this.closed && this.active && entry.generation === generation && this.entries.get(keyOf(entry.query)) === entry;}
    private async load(entry: Entry): Promise<void> {
        if (!this.active || this.closed || entry.loading || entry.editor) return;
        const generation = entry.generation, started = Date.now(); entry.loading = true; entry.error = ''; entry.status.textContent = ''; this.render(entry);
        try {
            const result = await this.commands.execute<IndependentCallInteractionDetail>(IndependentCallCommand.Interaction, entry.query);
            if (!this.current(entry, generation)) return;
            if (Object.entries(entry.query).some(([key, value]) => result?.[key as keyof IndependentCallResponseQuery] !== value)
                || result.interaction?.id !== entry.query.interactionId) throw Object.assign(new Error('CALL_INTERACTION_DETAIL_MISMATCH'), {code: 'CALL_INTERACTION_DETAIL_MISMATCH'});
            if (result.interaction.status !== 'pending') {entry.status.textContent = t('callable.independent.answer.resolved'); return;}
            if (this.drafts) {
                const {requestId: _requestId, ...scope} = entry.query;
                const draft = await InteractionDraftEditor.open(this.drafts, {...scope, requestedAt: result.interaction.requestedAt},
                    error => this.draftStatus(entry, error));
                if (!this.current(entry, generation)) return;
                entry.draft = draft;
            }
            this.mount(entry, result);
        } catch (error) {if (this.current(entry, generation)) this.fail(entry, error, started);}
        finally {log.debug('call.interaction', {operationId: entry.query.requestId, stage: 'detail', outcome: !this.current(entry, generation) ? 'ignored' : entry.error ? 'failure' : 'observed', durationMs: Date.now() - started});
            if (this.current(entry, generation)) {entry.loading = false; this.render(entry, this.record(entry));}}
    }
    private mount(entry: Entry, detail: IndependentCallInteractionDetail): void {
        const question = detail.interaction, payload = question.payload;
        const fields = question.kind === 'input' && payload && typeof payload === 'object' && !Array.isArray(payload) ? agentQuestionFields(payload.questions) : [];
        if (question.kind === 'input' && !fields.length) {
            const mode = document.createElement('select'); mode.setAttribute('aria-label', t('callable.independent.answer.format'));
            for (const value of ['text', 'json'] as const) {const option = document.createElement('option'); option.value = value; option.textContent = t(`callable.independent.answer.${value}`); mode.append(option);}
            mode.value = entry.draft?.content?.format ?? 'text';
            mode.onchange = () => this.saveDraft(entry);
            entry.mode = mode; entry.element.append(mode);
        }
        const common = {id: question.id, revision: question.requestedAt, state: 'pending' as const, title: question.prompt,
            detail: payload === undefined ? undefined : JSON.stringify(payload, null, 2)};
        entry.editor = createInteractionCard(question.kind === 'approval' ? {...common, kind: 'approval', note: true,
            decisions: [{id: 'approved', label: t('chatInput.interaction.approve')}, {id: 'rejected', label: t('chatInput.interaction.reject')}]}
            : {...common, kind: 'input', fields: fields.length ? fields : [{id: 'answer', label: t('chatInput.interaction.answer'), kind: 'text', multiline: true}]},
            response => this.submit(entry, response, fields), {locale: getLocale(), draft: entry.draft?.content?.editor,
                onDraftChange: () => this.saveDraft(entry)});
        entry.element.append(entry.editor.element); this.render(entry, this.record(entry));
    }
    private async submit(entry: Entry, response: InteractionResponse, fields: InputField[]): Promise<void> {
        const generation = entry.generation;
        if (!this.current(entry, generation) || this.record(entry)?.status === 'accepted') return;
        const previous = this.record(entry);
        if (previous && pending(previous)) {await this.read(entry, previous); throw new Error(t('callable.independent.answer.unknown'));}
        let value: IndependentCallResponseRequest['value'];
        if (response.kind === 'approval') value = {approved: response.decisionId === 'approved', ...(response.note ? {note: response.note} : {})};
        else if (fields.length) value = agentQuestionAnswer(fields, response);
        else {const text = String(response.values.answer ?? '');
            try {value = entry.mode?.value === 'json' ? JSON.parse(text) : text;} catch {throw new Error(t('callable.independent.answer.invalidJson'));}}
        this.saveDraft(entry);
        entry.submittedDraft = await entry.draft?.flush();
        if (!this.current(entry, generation)) return;
        if (entry.mode) entry.mode.disabled = true;
        try {
            const result = await this.controls.respond({...entry.query, requestId: randomUUID(), value}, () => this.current(entry, generation));
            if (result.status !== 'accepted') throw new Error(t('callable.independent.answer.unknown'));
            await this.clearDraft(entry);
        } catch (error) {
            const code = callControlErrorCode(error);
            throw new Error(t(code === 'CALL_CONTROL_SAVE_FAILED' ? 'callable.independent.control.saveFailed' : 'callable.independent.answer.failed', {code}));
        } finally {if (this.current(entry, generation)) {this.render(entry, this.record(entry)); this.refresh();}}
    }
    private async read(entry: Entry, record: OperationRecord): Promise<void> {
        if (!this.active || this.closed || entry.reading) return;
        const generation = entry.generation, started = Date.now(); entry.reading = true; this.render(entry, record);
        try {await this.controls.reconcile(record.context.operationId);
            if (this.record(entry)?.status === 'accepted') await this.clearDraft(entry);
            if (this.current(entry, generation)) entry.error = '';}
        catch (error) {if (this.current(entry, generation)) this.fail(entry, error, started);}
        finally {if (this.current(entry, generation)) {entry.reading = false; this.render(entry, this.record(entry));}}
    }
    private saveDraft(entry: Entry): void {
        if (!entry.editor || !this.active || this.closed) return;
        entry.draft?.save({format: entry.mode?.value === 'json' ? 'json' : 'text', values: {}, editor: entry.editor.getDraft()});
    }
    private async clearDraft(entry: Entry): Promise<void> {
        const expected = entry.submittedDraft; entry.submittedDraft = undefined;
        try {await entry.draft?.clear(expected);}
        catch (error) {this.draftStatus(entry, error);}
    }
    private draftStatus(entry: Entry, error?: unknown): void {
        if (this.closed || !this.entries.has(keyOf(entry.query))) return;
        const code = callControlErrorCode(error);
        entry.error = error ? t(code === 'INTERACTION_DRAFT_CONFLICT' ? 'callable.independent.answer.draftConflict' : 'callable.independent.answer.draftFailed', {code}) : undefined;
        entry.status.textContent = entry.error ?? '';
        if (!entry.retry) {
            entry.retry = document.createElement('button'); entry.retry.type = 'button'; entry.retry.textContent = t('application.retry');
            entry.retry.dataset.interactionDraftRetry = ''; entry.element.append(entry.retry);
            entry.retry.onclick = () => {void entry.draft?.retry().catch(error => this.draftStatus(entry, error));};
        }
        entry.retry.hidden = !error; entry.retry.disabled = !this.active;
    }
    private fail(entry: Entry, error: unknown, started: number): void {
        const code = callControlErrorCode(error); entry.error = t('callable.independent.answer.failed', {code}); entry.status.textContent = entry.error;
        log.warn('call.interaction', {operationId: entry.query.requestId, stage: 'observe', outcome: 'failure', code, durationMs: Date.now() - started});
    }
    private dispose(entry: Entry): void {entry.generation++; entry.editor?.destroy(); entry.button.onclick = null; if (entry.retry) entry.retry.onclick = null; entry.element.remove();}
}
function pending(record: OperationRecord): boolean {return record.status === 'submitting' || record.status === 'unknown';}
