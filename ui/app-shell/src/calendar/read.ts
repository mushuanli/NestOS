import {createModuleLogger, randomUUID} from '@itookit/common';
import type {IFileSystem, FSNode} from '@itookit/vfs-core';
import {parseCalendarEvent, type CalendarEvent, type CalendarSource} from './model';
const log = createModuleLogger('calendar');
export interface CalendarSnapshot {events: CalendarEvent[]; sources: CalendarSource[]; warnings: string[]}
const codeOf = (error: unknown) => (error as {code?: string})?.code ?? (error instanceof Error ? error.message : 'CALENDAR_READ_FAILED');

interface ReadState {events: CalendarEvent[]; warnings: string[]; declared: Map<string, CalendarSource>; bytes: number}

/** Read only this authorized workspace; checkpoints and private folders are excluded. */
export async function readCalendar(files: IFileSystem, signal: AbortSignal): Promise<CalendarSnapshot> {
    const operationId = randomUUID(), started = Date.now();
    const state: ReadState = {events: [], warnings: [], declared: new Map(), bytes: 0};
    try {
        for await (const node of calendarFiles(files, signal)) {
            try {await readEntry(files, node, state, signal);}
            catch (error) {
                if (codeOf(error) === 'CALENDAR_TOTAL_SIZE_LIMIT' || signal.aborted) throw error;
                state.warnings.push(safeCode(error));
            }
        }
        const {events, warnings, declared} = state;
        const sources = [...new Map([...events.map(event => [event.sourceId, {id: event.sourceId, name: event.sourceName}] as const), ...declared]).values()];
        log.info('calendar.read', {operationId, stage: 'complete', result: warnings.length ? 'partial' : 'success', count: events.length, sourceCount: sources.length, warningCount: warnings.length, durationMs: Date.now() - started});
        return {events, sources, warnings};
    } catch (error) {
        log.warn('calendar.read', {operationId, stage: 'read', result: 'failure', code: safeCode(error), durationMs: Date.now() - started});
        throw new Error(safeCode(error));
    }
}
async function* calendarFiles(files: IFileSystem, signal: AbortSignal): AsyncGenerator<FSNode> {
    const queue = ['/']; let visited = 0;
    while (queue.length) {
        signal.throwIfAborted();
        for (const node of await files.driver.getChildren(queue.shift()!, {includeHidden: true, signal})) {
            signal.throwIfAborted();
            if (++visited > 10000) throw new Error('CALENDAR_FILE_COUNT_LIMIT');
            if (node.name.startsWith('.') && node.name !== '.calendar-source.json') continue;
            if (node.type === 'directory') queue.push(node.path);
            else if (node.type === 'file' && /\.(json|md)$/.test(node.name)) yield node;
        }
    }
}
async function readEntry(files: IFileSystem, node: FSNode, state: ReadState, signal: AbortSignal): Promise<void> {
    if (node.type !== 'file') return;
    if (node.name === '.calendar-source.json') {
        const source = await readSource(files, node.path, signal); state.declared.set(source.id, source); return;
    }
    if ((node.size ?? 0) > 128 * 1024) throw new Error('CALENDAR_FILE_TOO_LARGE');
    const content = await files.driver.readContent(node.path, {encoding: 'utf-8', signal});
    const bytes = new TextEncoder().encode(content).byteLength; state.bytes += bytes;
    if (state.bytes > 16 * 1024 * 1024) throw new Error('CALENDAR_TOTAL_SIZE_LIMIT');
    if (bytes > 128 * 1024) throw new Error('CALENDAR_FILE_TOO_LARGE');
    const event = parseCalendarEvent(content, node.path); if (event) state.events.push(event);
}
async function readSource(files: IFileSystem, path: string, signal: AbortSignal): Promise<CalendarSource> {
    const node = await files.driver.getNode(path, {signal});
    if (node?.type !== 'file' || (node.size ?? 0) > 4096) throw new Error('CALENDAR_SOURCE_INVALID');
    const content = await files.driver.readContent(path, {encoding: 'utf-8', signal});
    if (content.length > 4096) throw new Error('CALENDAR_SOURCE_INVALID');
    const data = JSON.parse(content);
    if (data?.format !== 'nestos.calendar-source' || data.version !== 1 || typeof data.name !== 'string') throw new Error('CALENDAR_SOURCE_INVALID');
    return {id: path.slice(0, path.lastIndexOf('/')) || '/', name: [data.account, data.name].filter(value => typeof value === 'string' && value).join(' · '),
        account: typeof data.account === 'string' ? data.account : undefined, archivedAt: Number.isSafeInteger(data.archivedAt) ? data.archivedAt : undefined};
}
function safeCode(error: unknown): string {
    const code = codeOf(error);
    return /^(CALENDAR_[A-Z_]+|EACCES|ENOENT|ENETUNREACH|EIO)$/.test(code) ? code : error instanceof SyntaxError ? 'CALENDAR_EVENT_JSON_INVALID' : 'CALENDAR_READ_FAILED';
}
