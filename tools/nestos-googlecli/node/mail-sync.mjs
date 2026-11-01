import {fail} from './client.mjs';
import {mailMaterial, archived} from './materials.mjs';
import {pageState, nextPage} from './sync-batch.mjs';
import {digest} from './sync-store.mjs';
import {resolveMailBody} from './mail-body.mjs';
import {bodyDiagnostic} from './body-diagnostics.mjs';
const base = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function mailSync(client, args, context, directory, saved) {
    const profile = await client(base + '/profile', 'MAIL_PROFILE');
    if (typeof profile.historyId !== 'string' || !/^\d+$/.test(profile.historyId) || typeof profile.emailAddress !== 'string' || !profile.emailAddress)
        throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
    const account = digest(profile.emailAddress.toLowerCase());
    if (saved?.account && saved.account !== account) throw fail('GOOGLE_CONNECTION_ACCOUNT_CHANGED');
    context.mailSource = {format: 'nestos.mail-source', version: 1, provider: {id: 'google', name: 'Google'},
        account: {id: args.connection, name: profile.emailAddress}, name: 'Gmail'};
    return {
        async start() {
            return {mode: 'full', account, historyId: profile.historyId, pending: [], processed: 0, pageSize: Math.min(100, args.maxItems)};
        },
        page: state => mailPage(client, args, state),
        advance(state) {
            if (nextPage(state)) return false;
            if (state.mode === 'history') state.historyId = state.nextHistoryId;
            state.mode = 'history'; delete state.nextHistoryId; return true;
        },
        read: (entry, state) => mailEntry(client, args, context, directory, entry, state),
        expired: (error, state) => error.code === 'GOOGLE_MAIL_HISTORY_NOT_FOUND' || !!state.pageToken && error.code === 'GOOGLE_MAIL_LIST_HTTP_400',
    };
}
async function mailPage(client, args, state) {
    const history = state.mode === 'history', url = new URL(base + (history ? '/history' : '/messages'));
    url.search = new URLSearchParams({maxResults: String(state.pageSize), ...(history ? {startHistoryId: state.historyId} : {q: args.query}),
        ...(state.pageToken ? {pageToken: state.pageToken} : {})});
    const result = await client(url, history ? 'MAIL_HISTORY' : 'MAIL_LIST');
    if (history && (typeof result.historyId !== 'string' || !/^\d+$/.test(result.historyId))) throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
    pageState(state, result, history ? historyMessages(result) : messageIds(result));
}
async function mailEntry(client, args, context, directory, entry, state) {
    if (entry.removed) return null;
    let message;
    try {message = await client(base + '/messages/' + encodeURIComponent(entry.id) + '?format=full', 'MAIL_READ');}
    catch (error) {if (error.code === 'GOOGLE_MAIL_READ_NOT_FOUND') return null; throw error;}
    if (state.mode === 'history' && !await archived(context.vfs, directory, entry.id) && !await matches(client, args.query, message)) return null;
    try {return mailMaterial(await resolveMailBody(client, message));}
    catch (error) {
        error.diagnostic ??= bodyDiagnostic(message, message.payload, '0', 'materialize');
        throw error;
    }
}
function messageIds(result) {
    if (result.messages !== undefined && !Array.isArray(result.messages)) throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
    return [...new Set((result.messages ?? []).map(item => item?.id))].map(id => ({id}));
}
function historyMessages(result) {
    if (result.history !== undefined && !Array.isArray(result.history)) throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
    const messages = new Map();
    for (const record of result.history ?? []) for (const key of ['messagesAdded', 'labelsAdded', 'labelsRemoved', 'messagesDeleted']) {
        if (!record || typeof record !== 'object') throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
        if (record[key] !== undefined && !Array.isArray(record[key])) throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
        for (const entry of record[key] ?? []) messages.set(entry?.message?.id, {id: entry?.message?.id, removed: key === 'messagesDeleted'});
    }
    return [...messages.values()];
}
async function matches(client, query, message) {
    const header = message.payload?.headers?.find(item => item.name?.toLowerCase() === 'message-id')?.value?.trim();
    if (!header || /[\r\n]/.test(header) || header.length > 1000) throw fail('GOOGLE_MAIL_QUERY_ID_REQUIRED');
    let pageToken;
    for (let page = 0; page < 20; page++) {
        const url = new URL(base + '/messages');
        url.search = new URLSearchParams({q: '(' + query + ') rfc822msgid:' + JSON.stringify(header.replace(/^<|>$/g, '')), maxResults: '500', ...(pageToken ? {pageToken} : {})});
        const result = await client(url, 'MAIL_MATCH');
        if (messageIds(result).some(item => item.id === message.id)) return true;
        pageToken = result.nextPageToken; if (!pageToken) return false;
    }
    throw fail('GOOGLE_MAIL_QUERY_PAGE_LIMIT');
}
