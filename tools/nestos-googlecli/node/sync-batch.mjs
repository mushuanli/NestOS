import {fail} from './client.mjs';

/** Cursors advance in memory and commit only after archive writes succeed. */
export async function readBatch(provider, saved, args, context) {
    let state = saved ? structuredClone(saved) : await provider.start();
    if (state.cycleComplete) {state.processed = 0; state.cycleComplete = false;}
    const items = [], budget = {worked: 0, bytes: 0, pages: 0, resets: 0, deadline: context.batchDeadline ?? Date.now() + 45000};
    while (canWork(args, budget)) {
        context.signal?.throwIfAborted();
        state = await fillPending(provider, state, context, budget);
        if (state.cycleComplete) break;
        if (!state.pending.length) break;
        if (!acceptItem(await provider.read(state.pending[0], state), items, budget)) break;
        state.pending.shift(); state.processed++; budget.worked++;
    }
    finishPending(provider, state);
    return {state, items, complete: state.cycleComplete === true};
}
function canWork(args, budget) {
    return budget.worked < args.maxItems && budget.pages < 20 && (budget.worked === 0 || Date.now() < budget.deadline);
}
async function fillPending(provider, state, context, budget) {
    while (!state.pending.length && budget.pages < 20) {
        context.signal?.throwIfAborted();
        if (state.pageReady && provider.advance(state)) {state.cycleComplete = true; return state;}
        budget.pages++;
        try {await provider.page(state);}
        catch (error) {
            if (!provider.expired(error, state) || budget.resets++ >= 1) throw error;
            state = await provider.start(); await context.report?.('cursor-reset', error.code); continue;
        }
        state.pageReady = true;
    }
    return state;
}
function acceptItem(item, items, budget) {
    const size = item ? Buffer.byteLength(item.content) : 0;
    if (size > 128 * 1024) throw fail('GOOGLE_MATERIAL_LIMIT');
    if (budget.bytes + size > 4 * 1024 * 1024) return false;
    if (item) {items.push(item); budget.bytes += size;}
    return true;
}
function finishPending(provider, state) {
    if (state.pending.length || !state.pageReady || state.cycleComplete) return;
    state.cycleComplete = provider.advance(state);
}
export function pageState(state, result, pending) {
    if (result.nextPageToken && result.nextPageToken === state.pageToken) throw fail('GOOGLE_SYNC_CURSOR_STALLED');
    if (pending.length > 20000 || pending.some(item => typeof item.id !== 'string' || !item.id || item.id.length > 512)) throw fail('GOOGLE_SYNC_RESPONSE_INVALID');
    for (const key of ['nextPageToken', 'historyId', 'nextSyncToken'])
        if (result[key] !== undefined && (typeof result[key] !== 'string' || !result[key] || result[key].length > 8192)) throw fail('GOOGLE_SYNC_RESPONSE_INVALID');
    state.pending = pending; state.nextPageToken = result.nextPageToken;
    if (result.historyId) state.nextHistoryId = result.historyId;
    if (result.nextSyncToken) state.nextSyncToken = result.nextSyncToken;
}
export function nextPage(state) {
    state.pageToken = state.nextPageToken; state.pageReady = false; delete state.nextPageToken;
    return !!state.pageToken;
}
