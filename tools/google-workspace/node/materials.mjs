import {createHash} from 'node:crypto';
import {fail} from './client.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value : '';

export function mailMaterial(message) {
    if (!message.id || !message.payload) throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
    const headers = message.payload.headers ?? [];
    const header = name => text(headers.find(entry => entry.name?.toLowerCase() === name)?.value).replace(/[\r\n]+/g, ' ');
    const body = mailBody(message.payload);
    if (!body.trim()) throw fail('GOOGLE_MAIL_BODY_UNAVAILABLE');
    return {id: String(message.id), content: ['Source: Gmail', 'Message-ID: ' + message.id,
        ...['from', 'to', 'cc', 'date', 'subject'].map(name => name + ': ' + header(name)), '', body].join('\n')};
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
export function eventMaterial(event) {
    if (!event.id || typeof event.status !== 'string') throw fail('GOOGLE_CALENDAR_INVALID_RESPONSE');
    return {id: event.id, content: event.status === 'cancelled' ? JSON.stringify({source: 'Google Calendar', id: event.id, status: 'cancelled'})
        : JSON.stringify({source: 'Google Calendar', id: event.id, status: event.status, summary: text(event.summary),
            description: text(event.description), location: text(event.location), start: event.start, end: event.end,
            organizer: event.organizer, attendees: event.attendees, recurrence: event.recurrence, updated: event.updated}, null, 2)};
}

/** A complete bounded snapshot is fetched before any write or removal reconciliation. */
export async function saveMaterials(items, args, context, service) {
    if (!context.vfs?.writeFile || !context.vfs?.readFile || !context.operationId) throw fail('GOOGLE_WORKSPACE_REQUIRED');
    const root = args.directory.replace(/\/$/, '');
    if (!root || root.split('/').some(part => part === '..' || part.startsWith('.')) || root.includes('\\')) throw fail('GOOGLE_DIRECTORY_INVALID');
    const scope = hash(JSON.stringify([service, args.connection, service === 'gmail' ? '' : args.calendarId])).slice(0, 24);
    const directory = root + '/' + service + '-' + scope, manifest = directory + '/.sources.json';
    let previous = [];
    try {previous = JSON.parse(await context.vfs.readFile(manifest, {maxBytes: 128 * 1024}));}
    catch (error) {if (error?.code !== 'ENOENT') throw fail('GOOGLE_SOURCE_INDEX_READ_FAILED');}
    if (!Array.isArray(previous) || previous.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw fail('GOOGLE_SOURCE_INDEX_INVALID');
    const files = items.map(item => ({key: hash(item.id), content: item.content}));
    if (files.some(file => Buffer.byteLength(file.content) > 128 * 1024)
        || files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 4 * 1024 * 1024) throw fail('GOOGLE_MATERIAL_LIMIT');
    const current = new Set(files.map(file => file.key));
    try {
        for (const file of files) {context.signal?.throwIfAborted(); await context.vfs.writeFile(directory + '/' + file.key + '.md', file.content);}
        for (const id of previous.filter(id => !current.has(id))) {
            context.signal?.throwIfAborted();
            await context.vfs.writeFile(directory + '/' + id + '.md', 'Source unavailable in the latest complete collection. No supported personal facts.');
        }
        await context.vfs.writeFile(manifest, JSON.stringify([...current]));
    } catch {throw fail(context.signal?.aborted ? 'GOOGLE_CANCELLED' : 'GOOGLE_SOURCE_WRITE_FAILED');}
    return {count: files.length, removed: previous.filter(id => !current.has(id)).length, directory,
        include: ['file:' + directory + '/*.md'], complete: true};
}
