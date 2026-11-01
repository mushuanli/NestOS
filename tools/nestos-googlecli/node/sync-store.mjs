import {createHash} from 'node:crypto';
import {fail} from './client.mjs';
export const digest = value => createHash('sha256').update(value).digest('hex');

/** Existing Task assets freeze a connection's ordinary destination for reconciliation. */
export async function freezeDestination(service, args, client, context) {
    const key = 'google-destination/' + digest(context.operationId ?? '');
    const previous = await context.getAssetRecord?.(key);
    if (previous) {
        if (previous.version !== 1 || typeof previous.directory !== 'string') throw fail('GOOGLE_SYNC_STATE_INVALID');
        return {...args, directory: previous.directory, ...(args.resource ? {_scannerOutput: true} : {})};
    }
    const directory = args.resource ? context.cwd || '/workspace' : args.directory || client.destinations[service === 'gmail' ? 'mail' : 'calendar'];
    collectionDirectory(service, {...args, directory});
    await context.putAssetRecord?.(key, {version: 1, directory});
    return {...args, directory, ...(args.resource ? {_scannerOutput: true} : {})};
}

export function collectionDirectory(service, args) {
    const root = args.directory?.replace(/\/$/, '');
    if (!root || root.split('/').some(part => part === '..' || part.startsWith('.')) || root.includes('\\')) throw fail('GOOGLE_DIRECTORY_INVALID');
    if (args._scannerOutput) return root;
    const scope = digest(JSON.stringify([service, args.connection, args.sourceKey ?? 'default', service === 'gmail' ? '' : args.calendarId])).slice(0, 24);
    return args.resource ? root + '/' + args.connection + '/' + args.resource + '/' + (args.sourceKey ?? 'default') + (service === 'calendar' ? '-' + scope : '')
        : root + '/' + service + '-' + scope;
}
export async function readJson(vfs, path) {
    try {return JSON.parse(await vfs.readFile(path, {maxBytes: 4 * 1024 * 1024}));}
    catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw fail(error instanceof SyntaxError ? 'GOOGLE_SYNC_STATE_INVALID' : 'GOOGLE_SYNC_STATE_READ_FAILED');
    }
}
export async function writeJson(vfs, path, value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw fail('GOOGLE_SYNC_STATE_LIMIT');
    try {await vfs.writeFile(path, text);} catch {throw fail('GOOGLE_SYNC_STATE_WRITE_FAILED');}
}
export async function openSync(service, args, context) {
    if (!context.vfs?.writeFile || !context.vfs?.readFile || !context.operationId) throw fail('GOOGLE_WORKSPACE_REQUIRED');
    const directory = collectionDirectory(service, args), operation = digest(context.operationId);
    const signature = digest(JSON.stringify([service, args.query, args.calendarId, args.timeMin, args.timeMax, args.pastDays, args.futureDays]));
    const request = digest(JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))), file = directory + '/.sync.json';
    let state = await readJson(context.vfs, file);
    if (state) validateState(state);
    const account = state?.account;
    // Seal the preceding receipt before another operation may replace the single-file commit.
    if (state?.receipt) await writeJson(context.vfs, directory + '/.operations/' + state.receipt.operation + '.json', state.receipt);
    const receipt = await readJson(context.vfs, directory + '/.operations/' + operation + '.json');
    if (receipt) validateReceipt(receipt);
    if (receipt && (receipt.operation !== operation || receipt.request !== request)) throw fail('GOOGLE_SYNC_OPERATION_CONFLICT');
    if (state?.signature !== signature) state = null;
    return {directory, file, operation, signature, request, state, account, receipt: receipt?.result};
}
export async function commitSync(sync, state, result, context, client) {
    context.signal?.throwIfAborted(); await client.verifyConnection();
    await writeJson(context.vfs, sync.file, {version: 1, signature: sync.signature, ...state,
        receipt: {operation: sync.operation, request: sync.request, result}});
    return result;
}
function validateState(state) {
    if (!validHeader(state) || !validCounters(state) || !validPending(state.pending)) throw fail('GOOGLE_SYNC_STATE_INVALID');
    validateCursor(state);
    if (state.receipt) validateReceipt(state.receipt);
}
function validHeader(state) {return state.version === 1 && typeof state.signature === 'string' && ['full', 'history', 'delta', 'expand'].includes(state.mode);}
function validCounters(state) {return Number.isSafeInteger(state.processed) && state.processed >= 0 && Number.isSafeInteger(state.pageSize) && state.pageSize >= 1 && state.pageSize <= 500;}
function validPending(pending) {
    return Array.isArray(pending) && pending.length <= 20000 && pending.every(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 512
        && (item.removed === undefined || typeof item.removed === 'boolean'));
}
function validateCursor(state) {
    validateTokens(state);
    if (state.account !== undefined && !/^[a-f0-9]{64}$/.test(state.account)) throw fail('GOOGLE_SYNC_STATE_INVALID');
    if (state.mode === 'history' && !/^\d+$/.test(state.historyId ?? '')) throw fail('GOOGLE_SYNC_STATE_INVALID');
    if (['delta', 'expand'].includes(state.mode) && !state.syncToken) throw fail('GOOGLE_SYNC_STATE_INVALID');
}
function validateTokens(state) {
    for (const key of ['pageToken', 'nextPageToken', 'historyId', 'nextHistoryId', 'syncToken', 'nextSyncToken'])
        if (state[key] !== undefined && (typeof state[key] !== 'string' || state[key].length > 8192)) throw fail('GOOGLE_SYNC_STATE_INVALID');
}
function validateReceipt(receipt) {
    const result = receipt?.result, progress = result?.collection;
    if (!/^[a-f0-9]{64}$/.test(receipt?.operation ?? '') || !/^[a-f0-9]{64}$/.test(receipt?.request ?? '')
        || typeof result?.complete !== 'boolean' || !Number.isSafeInteger(result?.count) || result.count < 0
        || progress?.version !== 1 || progress.complete !== result.complete || !Number.isSafeInteger(progress.processed) || progress.processed < 0)
        throw fail('GOOGLE_SYNC_STATE_INVALID');
}
