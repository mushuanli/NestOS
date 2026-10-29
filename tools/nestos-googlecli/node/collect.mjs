import {fail, googleClient} from './client.mjs';
import {mailMaterial, eventMaterial, saveMaterials} from './materials.mjs';

export async function collectGoogle(service, args, context, connections, fetcher = fetch) {
    const started = Date.now(); let stage = 'authorization';
    const report = async (result, code, count) => context.onProgress?.({message: JSON.stringify({operation: 'google.' + service + '.collect',
        operationId: context.operationId, stage, result, code, count, durationMs: Date.now() - started})});
    try {
        const signal = AbortSignal.any([context.signal ?? new AbortController().signal, AbortSignal.timeout(120000)]);
        const client = await googleClient(connections, args.connection, signal, fetcher);
        if (!args.directory) args = {...args, directory: client.destinations[args.resource]};
        stage = 'fetch';
        const items = service === 'gmail' ? await mails(client, args, signal) : await events(client, args, signal);
        stage = 'connection-check'; await client.verifyConnection();
        stage = 'persist'; const result = await saveMaterials(items, args, {...context, signal}, service);
        await report('success', undefined, result.count); return result;
    } catch (error) {
        const code = /^(GOOGLE_|TOOL_CONNECTION_|TOOL_AUTH_|RESOURCE_)[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'GOOGLE_COLLECTION_FAILED';
        await report('failure', code); throw fail(code);
    }
}
async function mails(client, args, signal) {
    const ids = new Set(); let pageToken;
    for (let page = 0; page < 20; page++) {
        signal.throwIfAborted();
        const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
        url.search = new URLSearchParams({q: args.query, maxResults: String(Math.min(100, args.maxItems + 1)), ...(pageToken ? {pageToken} : {})});
        const result = await client(url, 'MAIL_LIST');
        if (result.messages !== undefined && !Array.isArray(result.messages)) throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
        for (const item of result.messages ?? []) {if (!item.id) throw fail('GOOGLE_MAIL_INVALID_RESPONSE'); ids.add(item.id);}
        if (ids.size > args.maxItems) throw fail('GOOGLE_COLLECTION_LIMIT_REFINE_RANGE');
        pageToken = result.nextPageToken; if (!pageToken) break;
    }
    if (pageToken) throw fail('GOOGLE_COLLECTION_PAGE_LIMIT');
    const items = [];
    for (const id of [...ids].sort()) {
        signal.throwIfAborted();
        const message = await client('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(id) + '?format=full', 'MAIL_READ');
        items.push(mailMaterial(message));
    }
    return items;
}
async function events(client, args, signal) {
    const now = Date.now();
    const from = new Date(args.timeMin ?? now - (args.pastDays ?? 7) * 86400000), to = new Date(args.timeMax ?? now + (args.futureDays ?? 30) * 86400000);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || +from >= +to || +to - +from > 366 * 86400000) throw fail('GOOGLE_CALENDAR_RANGE_INVALID');
    const items = new Map(); let pageToken;
    for (let page = 0; page < 20; page++) {
        signal.throwIfAborted();
        const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(args.calendarId) + '/events');
        url.search = new URLSearchParams({timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', showDeleted: 'true',
            maxResults: String(Math.min(250, args.maxItems + 1)), ...(pageToken ? {pageToken} : {})});
        const result = await client(url, 'CALENDAR_LIST');
        if (result.items !== undefined && !Array.isArray(result.items)) throw fail('GOOGLE_CALENDAR_INVALID_RESPONSE');
        for (const event of result.items ?? []) {const item = eventMaterial(event); items.set(item.id, item);}
        if (items.size > args.maxItems) throw fail('GOOGLE_COLLECTION_LIMIT_REFINE_RANGE');
        pageToken = result.nextPageToken; if (!pageToken) return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    throw fail('GOOGLE_COLLECTION_PAGE_LIMIT');
}
