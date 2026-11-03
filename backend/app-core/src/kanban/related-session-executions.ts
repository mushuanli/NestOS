import {taskStat, type Kernel, type TaskRecord} from '@itookit/durable-kernel';
import type {ISessionRepository, Round} from '@itookit/llm-session/contracts';
import type {KanbanSessionExecution} from '@itookit/kanban/contracts';
import {readContextCatalog} from '../projects/harness-context-catalog';
import {harnessExecutionJournalKey, type ExecutionJournalData} from '../projects/harness-execution-journal';
import {requireValue} from './validation';

export interface SessionExecutionOptions {
    repository: Pick<ISessionRepository, 'readDocument'>;
    kernel: Pick<Kernel, 'inspectSession'>;
    resources?(id: string): Promise<Array<{label: string; value: string}>>;
}
type Snapshot = Awaited<ReturnType<Awaited<ReturnType<Kernel['inspectSession']>>['snapshot']>>;
interface Readers {snapshot(id: string): Promise<Snapshot>; catalog(id: string): ReturnType<typeof readContextCatalog>}
/** One cold snapshot per Session. Round bodies and Kernel records never leave this projection. */
export function relatedExecutionReader(options: SessionExecutionOptions) {
    const readers = {snapshot: cachedReader((id: string) => options.kernel.inspectSession(id).then(reader => reader.snapshot())),
        catalog: cachedReader((id: string) => readContextCatalog(options.kernel, id))};
    return (sessionId: string, execution: KanbanSessionExecution) => projectExecution(options, readers, sessionId, execution);
}
function cachedReader<T>(read: (id: string) => Promise<T>): (id: string) => Promise<T> {
    const cache = new Map<string, Promise<T>>();
    return id => {let value = cache.get(id); if (!value) {value = read(id); cache.set(id, value);} return value;};
}
async function projectExecution(options: SessionExecutionOptions, readers: Readers, sessionId: string, execution: KanbanSessionExecution): Promise<KanbanSessionExecution> {
    requireValue(/^[\w.:-]{1,256}$/.test(execution.id), 'SESSION_RELATION_ID_INVALID');
    const [raw, resources] = await Promise.all([options.repository.readDocument(sessionId, `round-${execution.id}.json`), options.resources?.(execution.id)]);
    if (!raw) return {...execution, ...(resources?.length ? {resources} : {})};
    const round = JSON.parse(raw) as Round;
    requireValue(round.id === execution.id && round.sessionId === sessionId, 'SESSION_RELATION_SCOPE_MISMATCH');
    const primary = round.executions.find(ref => ref.role === 'primary');
    const snapshot = primary ? await readers.snapshot(sessionId) : undefined;
    const task = snapshot?.tasks.find(row => row.id === primary?.taskId);
    if (task) requireValue(task.sessionId === sessionId && task.labels?.roundId === round.id
        && (!primary?.invocation || task.labels?.invocationId === primary.invocation.invocationId), 'SESSION_RELATION_EXECUTION_MISMATCH');
    const state = executionState(round, task, snapshot);
    const completedAt = task ? task.exit?.completedAt : round.completedAt;
    const turnId = primary?.invocation ? await executionTurn(options.kernel, sessionId, primary.invocation.invocationId, await readers.catalog(sessionId)) : undefined;
    return {...execution, roundId: round.id, state, createdAt: round.createdAt,
        ...(['completed', 'failed', 'cancelled'].includes(state) && completedAt !== undefined ? {completedAt} : {}),
        ...(turnId ? {turnId} : {}), ...(resources?.length ? {resources} : {})};
}

function executionState(round: Round, task: TaskRecord | undefined, snapshot: Snapshot | undefined): NonNullable<KanbanSessionExecution['state']> {
    if (!task) return round.status === 'pending' ? 'queued' : round.status;
    const stat = taskStat(task), descendants = snapshot?.tasks.filter(row => task.rootTaskId ? row.rootTaskId === task.rootTaskId : row.id === task.id) ?? [];
    if (stat.settled && descendants.every(row => taskStat(row).settled) && task.exit)
        return ({succeeded: 'completed', failed: 'failed', cancelled: 'cancelled'} as const)[task.exit.status];
    if (task.sessionPaused || task.control?.mode === 'pause' || task.controlHolds?.length) return 'paused';
    if (stat.phase === 'waiting' || stat.phase === 'running') return stat.phase;
    if (stat.phase === 'created' || stat.phase === 'ready') return 'queued';
    return 'unknown';
}
async function executionTurn(kernel: SessionExecutionOptions['kernel'], sessionId: string, invocationId: string, catalog: Awaited<ReturnType<typeof readContextCatalog>>) {
    for (const binding of Object.values(catalog.value.bindings)) {
        const checkpoint = binding.checkpoints?.find(row => row.kind === 'terminal' && row.operation.invocationId === invocationId);
        if (checkpoint) return checkpoint.ref;
        const operation = binding.activeOperation;
        if (!operation || operation.invocationId !== invocationId) continue;
        const identity = {sessionId, ...operation.executionRef}, key = harnessExecutionJournalKey(identity);
        const saved = await (await kernel.inspectSession(sessionId)).getShared(key), journal = saved?.value as unknown as ExecutionJournalData | undefined;
        requireValue(!journal || journal.bindingId === binding.id && JSON.stringify(journal.owner) === JSON.stringify([sessionId, identity.taskId, identity.effectId]), 'SESSION_RELATION_NATIVE_MISMATCH');
        return journal?.turnId;
    }
}
