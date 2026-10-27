import type { HarnessEvents, HarnessHistory } from '@itookit/nestos-node-driver';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import type { HarnessExecutionResult } from '@itookit/kernel-adapters/contracts';
import { canonical } from './harness-connection-policy';
import { executionError, type ExecutionJournalData, type NativeText } from './harness-execution-journal';
import { nativeOptions, type NativeExecution } from './harness-execution-operations';
import { driveNativeInteractions } from './harness-execution-interactions';
import {settleExecutionContext} from './harness-execution-context';

type Terminal = ExecutionJournalData['terminal'];
type Message = HarnessEvents['events'][number]['message'];
type HistoryRow = { id?: string; status?: string; items?: unknown[]; threadId?: string };
export function nativeTerminal(status: unknown): Terminal {
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
    if (status === 'interrupted') return 'cancelled';
}
function nativeText(value: unknown, turnId: string, parentTurn?: string): NativeText | undefined {
    const item = value as { type?: string; id?: string; turnId?: string; text?: unknown; content?: unknown[] };
    if (!item || item.type !== 'agentMessage' || (item.turnId ?? parentTurn) !== turnId) return;
    if (typeof item.id !== 'string' || !item.id) throw executionError('NATIVE_ITEM_INVALID');
    const text = typeof item.text === 'string' ? item.text : (item.content ?? []).flatMap(part => {
        if (typeof part === 'string') return [part];
        const text = (part as { text?: unknown })?.text;
        return typeof text === 'string' ? [text] : [];
    }).join('\n');
    return { id: item.id, text };
}
function mergeTexts(first: NativeText[], second: NativeText[]): NativeText[] {
    const texts = [...new Map([...first, ...second].map(item => [item.id, item])).values()];
    if (texts.length > 1000 || new TextEncoder().encode(JSON.stringify(texts)).byteLength > 2 * 1024 * 1024)
        throw executionError('NATIVE_OUTPUT_LIMIT');
    return texts;
}
function eventChanges(data: ExecutionJournalData, page: HarnessEvents): Partial<ExecutionJournalData> {
    let terminal = data.terminal, texts = data.texts;
    for (const { message } of page.events) {
        const params = message.params;
        if (disconnected(message, data.sessionId) && !terminal)
            throw executionError('NATIVE_DISCONNECTED');
        if (!params || params.threadId !== data.sessionId) continue;
        terminal = eventTerminal(message, data.turnId) ?? terminal;
        if (message.method === 'item/completed') {
            const text = nativeText(params.item, data.turnId!, params.turnId as string | undefined);
            if (text) texts = mergeTexts(texts, [text]);
        }
    }
    return { ...(terminal ? { terminal } : {}), texts, cursor: { after: page.cursor, eventEpoch: page.epoch } };
}
function disconnected(message: Message, sessionId?: string): boolean {
    return message.method === 'harness/disconnected' && (!message.params?.threadId || message.params.threadId === sessionId);
}
function eventTerminal(message: Message, turnId?: string): Terminal {
    const turn = message.params?.turn as { id?: string; status?: string } | undefined;
    if (message.method === 'turn/completed' && turn?.id === turnId) return nativeTerminal(turn?.status);
}
function historyChanges(data: ExecutionJournalData, history: HarnessHistory): Partial<ExecutionJournalData> {
    let terminal = data.terminal;
    const texts: NativeText[] = [];
    for (const value of history.turns ?? []) {
        const turn = value as HistoryRow;
        if (turn.threadId !== undefined && turn.threadId !== data.sessionId) continue;
        terminal = historyTerminal(turn, data.turnId) ?? terminal;
        texts.push(...historyRowTexts(turn, data.turnId!));
    }
    return { ...(terminal ? { terminal } : {}), texts };
}
function historyTerminal(turn: HistoryRow, turnId?: string): Terminal {
    if (turn.id === turnId && Array.isArray(turn.items)) return nativeTerminal(turn.status);
}
function historyRowTexts(turn: HistoryRow, turnId: string): NativeText[] {
    const texts: NativeText[] = [], flat = nativeText(turn, turnId);
    if (flat) texts.push(flat);
    for (const item of turn.items ?? []) {
        const text = nativeText(item, turnId, turn.id);
        if (text) texts.push(text);
    }
    return texts;
}
export async function refreshNativeHistory(run: NativeExecution): Promise<boolean> {
    const { client, profile } = run.acquired, data = run.journal.data;
    const cursors = new Set<string>();
    let cursor: string | undefined, texts: NativeText[] = [], terminal = data.terminal, active = false;
    do {
        run.signal.throwIfAborted();
        const history = await client.read(profile.id, data.sessionId!, { ...nativeOptions(run), ...(cursor ? { cursor } : {}) });
        if (history.session.id !== data.sessionId) throw executionError('NATIVE_SESSION_MISMATCH');
        if (!cursor) active = history.session.activeTurnId === data.turnId;
        const update = historyChanges(data, history);
        texts = mergeTexts(update.texts ?? [], texts); terminal = update.terminal ?? terminal;
        cursor = history.nextCursor ?? undefined;
        trackHistoryCursor(cursor, cursors);
    } while (cursor);
    const known = new Set(texts.map(item => item.id));
    await saveChanges(run, { ...(terminal ? { terminal } : {}), texts: mergeTexts(texts, data.texts.filter(item => !known.has(item.id))) });
    return active;
}
function trackHistoryCursor(cursor: string | undefined, cursors: Set<string>): void {
    if (!cursor) return;
    if (cursors.has(cursor) || cursors.size >= 100) throw executionError('NATIVE_HISTORY_LIMIT');
    cursors.add(cursor);
}
async function saveChanges(run: NativeExecution, update: Partial<ExecutionJournalData>): Promise<void> {
    if (canonical({ ...run.journal.data, ...update }) !== canonical(run.journal.data)) await run.journal.save(update);
}
export async function observeNativePage(run: NativeExecution): Promise<HarnessEvents> {
    const page = await run.acquired.client.eventSnapshot(run.acquired.profile.id, run.journal.data.cursor, nativeOptions(run));
    await saveChanges(run, eventChanges(run.journal.data, page));
    if (page.gap) {
        const active = await refreshNativeHistory(run);
        if (!run.journal.data.terminal && !active) throw executionError('NATIVE_TERMINAL_UNKNOWN');
    }
    return page;
}
export async function observeNativeTurn(run: NativeExecution, context: EffectExecutionContext, pollMs: number): Promise<HarnessExecutionResult> {
    const stop = run.acquired.client.subscribe(run.acquired.profile.id, () => {});
    try {
        while (!run.journal.data.terminal) {
            run.signal.throwIfAborted();
            const page = await observeNativePage(run);
            if (!run.journal.data.terminal) await driveNativeInteractions(run, context, page);
            if (!run.journal.data.terminal) await waitForNativeChange(run, pollMs);
        }
        if (run.journal.data.terminal === 'completed' && !run.journal.data.outputChecked) {
            await observeNativePage(run);
            await refreshNativeHistory(run);
            await run.journal.save({ outputChecked: true });
        }
        return finishNativeTurn(run);
    } finally { stop(); }
}
export async function finishNativeTurn(run: Pick<NativeExecution, 'journal'>): Promise<HarnessExecutionResult> {
    const data = run.journal.data;
    if (data.result) return data.result;
    if (data.terminal === 'completed' && !data.outputChecked) throw executionError('NATIVE_OUTPUT_UNCHECKED');
    const contextBinding = data.terminal ? await settleExecutionContext(run.journal) : undefined;
    if (data.terminal !== 'completed') throw executionError(data.terminal === 'cancelled' ? 'NATIVE_TURN_CANCELLED' : 'NATIVE_TURN_FAILED');
    const result = { sessionId: data.sessionId!, turnId: data.turnId!, text: data.texts.map(item => item.text).join('\n'),
        ...(contextBinding ? {contextBinding} : {}) };
    await run.journal.save({ result });
    return result;
}
export function waitForNativeChange(run: NativeExecution, milliseconds: number): Promise<void> {
    run.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let stop = () => {};
        const finish = () => { clearTimeout(timer); stop(); run.signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); stop(); run.signal.removeEventListener('abort', abort); reject(executionError('OBSERVATION_ABORTED')); };
        const timer = setTimeout(finish, milliseconds);
        stop = run.acquired.client.subscribe(run.acquired.profile.id, finish);
        run.signal.addEventListener('abort', abort, { once: true });
        if (run.signal.aborted) abort();
    });
}
