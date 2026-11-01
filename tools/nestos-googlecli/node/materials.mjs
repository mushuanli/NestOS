import {fail} from './client.mjs';
import {collectionDirectory, digest as hash, readJson, writeJson} from './sync-store.mjs';
const text = value => typeof value === 'string' ? value : '';

export function mailMaterial(message) {
    if (!message.id || !message.payload) throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
    const headers = message.payload.headers ?? [];
    const header = name => text(headers.find(entry => entry.name?.toLowerCase() === name)?.value).replace(/[\r\n]+/g, ' ');
    const body = mailBody(message.payload);
    const bodyStatus = body.trim() ? 'available' : emptyBodyStatus(message.payload);
    return {id: String(message.id), content: ['Source: Gmail', 'Message-ID: ' + message.id,
        ...['from', 'to', 'cc', 'date', 'subject'].map(name => name + ': ' + header(name)),
        ...(bodyStatus === 'available' ? [] : ['Body-Status: ' + bodyStatus]), '', body || '[No text body; file attachments are not collected.]'].join('\n')};
}
function emptyBodyStatus(part, depth = 0) {
    if (depth > 20) throw fail('GOOGLE_MAIL_MIME_LIMIT');
    if (part.filename) return 'attachments-only';
    if (part.mimeType?.startsWith('multipart/')) {
        const statuses = (part.parts ?? []).map(child => emptyBodyStatus(child, depth + 1));
        return statuses.includes('attachments-only') ? 'attachments-only' : 'empty';
    }
    if (!['text/plain', 'text/html'].includes(part.mimeType)) throw fail('GOOGLE_MAIL_BODY_UNSUPPORTED');
    if (part.body?.attachmentId && !part.body.data) throw fail('GOOGLE_MAIL_BODY_UNAVAILABLE');
    if (!part.body || !('data' in part.body) && part.body.size !== 0) throw fail('GOOGLE_MAIL_BODY_UNAVAILABLE');
    return 'empty';
}
function mailBody(part, depth = 0) {
    if (depth > 20) throw fail('GOOGLE_MAIL_MIME_LIMIT');
    if (part.filename) return '';
    if (part.mimeType?.startsWith('multipart/')) {
        const bodies = (part.parts ?? []).map(child => ({part: child, body: mailBody(child, depth + 1)}));
        const plain = bodies.filter(child => child.part.mimeType === 'text/plain' && child.body);
        return (part.mimeType === 'multipart/alternative' && plain.length ? plain : bodies).map(child => child.body).filter(Boolean).join('\n');
    }
    if (!['text/plain', 'text/html'].includes(part.mimeType) || !part.body?.data) return '';
    const charset = (part.headers ?? []).find(header => header.name?.toLowerCase() === 'content-type')?.value?.match(/charset=["']?([^\s;"']+)/i)?.[1] ?? 'utf-8';
    let body;
    try {body = new TextDecoder(charset, {fatal: true}).decode(Buffer.from(part.body.data, 'base64url'));}
    catch {throw fail('GOOGLE_MAIL_ENCODING_UNSUPPORTED');}
    if (part.mimeType === 'text/plain') return body;
    return body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '\n')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}
export function eventMaterial(event, args = {}) {
    if (!event.id || typeof event.status !== 'string') throw fail('GOOGLE_CALENDAR_INVALID_RESPONSE');
    return {id: event.id, content: event.status === 'cancelled' ? JSON.stringify({source: 'Google Calendar', id: event.id, status: 'cancelled'})
        : JSON.stringify({source: 'Google Calendar', calendar: {id: args.calendarId ?? 'primary', account: args.connection}, id: event.id, status: event.status, summary: text(event.summary),
            description: text(event.description), location: text(event.location), start: event.start, end: event.end,
            organizer: event.organizer, attendees: event.attendees, recurrence: event.recurrence, updated: event.updated}, null, 2)};
}

/** Upsert stable archive files; absence from a later window never deletes historical material. */
export async function saveMaterials(items, args, context, service) {
    if (!context.vfs?.writeFile || !context.vfs?.readFile || !context.operationId) throw fail('GOOGLE_WORKSPACE_REQUIRED');
    const extension = args.resource === 'mail' ? 'email' : 'md';
    const directory = collectionDirectory(service, args);
    const files = items.map(item => ({key: hash(item.id), content: item.content}));
    if (files.some(file => Buffer.byteLength(file.content) > 128 * 1024)
        || files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 4 * 1024 * 1024) throw fail('GOOGLE_MATERIAL_LIMIT');
    try {
        for (const file of files) {
            context.signal?.throwIfAborted();
            const path = directory + '/' + file.key + '.' + extension;
            let previous;
            try {previous = await context.vfs.readFile(path, {maxBytes: 128 * 1024});} catch (error) {if (error?.code !== 'ENOENT') throw error;}
            if (previous !== file.content) await context.vfs.writeFile(path, file.content);
        }
        if (service === 'calendar') await writeJson(context.vfs, directory + '/.calendar-source.json', {
            format: 'nestos.calendar-source', version: 1, name: args.calendarId ?? 'primary', account: args.connection, archivedAt: Date.now()});
        if (service === 'gmail' && context.mailSource) await writeJson(context.vfs, directory + '/.mail-source.json', {...context.mailSource, archivedAt: Date.now()});
    } catch {throw fail(context.signal?.aborted ? 'GOOGLE_CANCELLED' : 'GOOGLE_SOURCE_WRITE_FAILED');}
    for (const item of items) await writeJson(context.vfs, directory + '/.items/' + hash(item.id) + '.json', {id: item.id});
    return {count: files.length, removed: 0, directory,
        include: ['file:' + directory + '/*.' + extension], complete: true};
}
export async function archived(vfs, directory, id) {return !!await readJson(vfs, directory + '/.items/' + hash(id) + '.json');}
