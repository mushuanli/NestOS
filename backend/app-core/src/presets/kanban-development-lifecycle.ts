import {lifecyclePromptFiles} from '../run/prompt-lifecycle';
import {developmentObservation} from './kanban-development-log';
import {t} from '@itookit/common';
import type {TargetRef} from '@itookit/llm-flow/contracts';
import type {KanbanDispatch, KanbanItem, KanbanSessionAssociation} from '@itookit/kanban/contracts';
import type {KanbanExecutionObservation} from '@itookit/kanban/execution';
import type {UserEventService} from '../events/service';
import {createPublishedKanbanWorkExecutor, type PublishedKanbanWorkOptions} from '../kanban/published-work';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import type {DevelopmentPolicy} from './kanban-development-policy';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {failure, hasMarkdownSection} from '../run/prompt-bundle';

interface Options extends Pick<PublishedKanbanWorkOptions, 'calls' | 'kernel' | 'prepareSession'> {authorize?(boardId: string): Promise<boolean>; journal: KanbanAutomationJournal; events: UserEventService}
interface Job {id: string; boardId: string; dispatch: KanbanDispatch; stage: string; request: unknown; phase: 'prepared' | 'submitting'; done?: boolean; observation?: KanbanExecutionObservation}
/** Terminal hooks are independent calls; cancellation never sends into the stopped turn. */
interface State {stopped: boolean; pending?: Promise<void>; executor: ReturnType<typeof createPublishedKanbanWorkExecutor>}
export function developmentLifecycle(options: Options) {
    const state: State = {stopped: false, executor: lifecycleExecutor(options)};
    const scan = () => {
        if (state.stopped) return Promise.resolve();
        return state.pending ??= advance(options, state).finally(() => {state.pending = undefined;});
    };
    return {scan, sessions: (boardId: string, itemId: string) => developmentLifecycleSessions(options, boardId, itemId),
        async settled(dispatchId: string, outcome: string) {
            const job = await options.journal.get<Job>('development-lifecycle:' + dispatchId + '-postload-' + outcome);
            return !job || job.done === true;
        }, async dispose() {state.stopped = true; await state.pending;},
        enqueue: (boardId: string, dispatch: KanbanDispatch, item: KanbanItem, observation: KanbanExecutionObservation, kind: 'task' | 'decision' = 'task', target?: TargetRef) =>
            enqueue(options, state, boardId, dispatch, item, observation, kind, target)};
}
/** Read only the actual child identity; a caller or an unsubmitted hook is not an execution Session. */
export async function developmentLifecycleSessions(options: Pick<Options, 'journal' | 'calls'>, boardId: string, itemId: string): Promise<KanbanSessionAssociation[]> {
    const keys = await options.journal.get<string[]>('development-lifecycle-index') ?? [], rows: KanbanSessionAssociation[] = [];
    for (const key of keys) {
        const job = await options.journal.get<Job>(key);
        if (!job || job.boardId !== boardId || job.dispatch.itemId !== itemId) continue;
        const request = job.request as {input: import('@itookit/llm-session/contracts').IndependentCallInput};
        const admission = await options.calls.inspectTaskCallSubmission(request.input);
        if (admission?.executionSessionId) rows.push({sessionId: admission.executionSessionId, purpose: 'finalization', execution: {id: job.id, purpose: 'finalization'}});
    }
    return rows;
}
function lifecycleExecutor(options: Options) {
    return createPublishedKanbanWorkExecutor({...options, title: (dispatch, item) => `${t('kanban.lifecycleTitle', {stage: dispatch.id.split('-postload-').at(-1) ?? ''})} · ${item.number ? '#' + item.number : item.title}`, binding: async dispatch => {
        const id = dispatch.id.replace(/-postload-(succeeded|failed|cancelled)$/, '');
        const override = await options.journal.get<TargetRef>('lifecycle-target:' + dispatch.id);
        if (override) return {target: override};
        const managed = await options.journal.get<{target?: TargetRef}>('managed-agent:work-' + id);
        if (!managed?.target) throw failure('LIFECYCLE_TARGET_MISSING'); return {target: managed.target};
    }, context: async dispatch => ({lifecycle: {stage: 'postload.' + dispatch.id.split('-postload-').at(-1)}})});
}
async function advance(options: Options, state: State) {
        for (const key of await options.journal.get<string[]>('development-lifecycle-index') ?? []) {
            if (state.stopped) return;
            const job = await options.journal.get<Job>(key); if (!job) continue;
            if (job.done) {if (job.observation) await report(options.events, job, job.observation); continue;}
            if (job.phase === 'prepared' && options.authorize && !await options.authorize(job.boardId)) continue;
            if (state.stopped) return;
            const claimed = job.phase === 'prepared' && await options.journal.claim(key);
            if (state.stopped) return;
            const started = Date.now();
            let observation: KanbanExecutionObservation;
            try {observation = await (claimed ? state.executor.start(job.request) : state.executor.inspect(job.request));}
            catch {observation = {outcome: 'unknown', code: 'LIFECYCLE_OBSERVATION_UNKNOWN'};}
            if (state.stopped) return;
            developmentObservation(job.id, job.stage, observation.outcome, observation.code, Date.now() - started);
            const done = ['succeeded', 'failed', 'cancelled'].includes(observation.outcome);
            await options.journal.update<Job>(key, old => ({...old!, observation, done}));
            if (done) await report(options.events, job, observation);
        }
    }
async function enqueue(options: Options, state: State, boardId: string, dispatch: KanbanDispatch, item: KanbanItem, observation: KanbanExecutionObservation, kind: 'task' | 'decision', target?: TargetRef) {
        if (state.stopped || !['succeeded', 'failed', 'cancelled'].includes(observation.outcome)) return;
        const workspace = await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + dispatch.id);
        const stage = 'postload.' + observation.outcome;
        const policy = workspace?.policy ?? await options.journal.get<DevelopmentPolicy>('development-policy:' + dispatch.id);
        const file = kind + '.md', prompt = policy?.prompts.files.find(entry => entry.name === file)?.content;
        const hooks=policy?lifecyclePromptFiles(policy.prompts,kind,observation.outcome as 'succeeded'|'failed'|'cancelled'):[];
        if (dispatch.continuation && policy?.prompts.files.some(file => file.name === kind + '-continue-post.md')) hooks.unshift(kind + '-continue-post.md');
        if (!prompt || !hasMarkdownSection(prompt, stage)&&!hooks.length) return;
        const id = dispatch.id + '-postload-' + observation.outcome, key = 'development-lifecycle:' + id;
        if (state.stopped) return;
        if (!await options.journal.get<Job>(key)) {
            if (target) await options.journal.update<TargetRef>('lifecycle-target:' + id, old => old ?? target);
            const hookDispatch = {...dispatch, id};
            const directory = workspace?.communicationDirectory?.replace('/workspace/', '') ?? '_nestos/kanban';
            const hookItem = {...item, responsibility: `Execute ONLY ${stage} and the non-destructive cleanup guidance in ${directory}/prompts/${file}. The original task is terminal. Do not implement, commit, merge, push, or publish primary result. Report retained work and recovery information. Original code: ${observation.code ?? 'NONE'}. Read the frozen prompts from the manifest, followed by these optional files in order: ${hooks.map(name=>directory+'/prompts/'+name).join(', ')||'(none)'}.`,
                acceptance: 'Return a concise lifecycle summary. Preserve repository state and mailbox history.'};
            const request = await state.executor.prepare(hookDispatch, hookItem);
            await options.journal.update<Job>(key, old => old ?? {id, boardId, dispatch: hookDispatch, stage, request, phase: 'prepared'});
        }
        await options.journal.update<string[]>('development-lifecycle-index', old => old?.includes(key) ? old : [...old ?? [], key]);
}

async function report(events: UserEventService, job: Job, observation: KanbanExecutionObservation): Promise<void> {
    await events.journal.transaction(async tx => {
        const key = 'lifecycle:' + job.id; if (await tx.getState(key)) return;
        await tx.append(key, {type: 'kanban.lifecycle.' + observation.outcome, operationId: job.id,
            resourceId: 'kanban:' + JSON.stringify(['personal:user-store', job.boardId, job.dispatch.itemId]),
            notification: observation.outcome === 'succeeded' ? 'info' : 'error'}, Date.now());
        await tx.setState(key, 'delivered');
    });
}
