import {fail} from './client.mjs';

/** Fetch detached text bodies only; named file attachments remain excluded. */
export async function resolveMailBody(client, message) {
    const budget = {bytes: 0, parts: 0};
    const visit = async (part, depth = 0) => {
        if (!part || typeof part !== 'object') throw fail('GOOGLE_MAIL_INVALID_RESPONSE');
        if (depth > 20 || ++budget.parts > 500) throw fail('GOOGLE_MAIL_MIME_LIMIT');
        if (part.filename) return part;
        if (part.mimeType?.startsWith('multipart/')) {
            const parts = [];
            for (const child of part.parts ?? []) parts.push(await visit(child, depth + 1));
            return {...part, parts};
        }
        if (!['text/plain', 'text/html'].includes(part.mimeType)) return part;
        let body = part.body;
        if (!body?.data && body?.attachmentId) {
            if (body.size > 128 * 1024) throw fail('GOOGLE_MATERIAL_LIMIT');
            body = await client('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(message.id)
                + '/attachments/' + encodeURIComponent(body.attachmentId), 'MAIL_BODY_READ');
            if (typeof body.data !== 'string' || !body.data && body.size !== 0) throw fail('GOOGLE_MAIL_BODY_INVALID_RESPONSE');
        }
        if (!body || typeof body.data !== 'string' && body.size !== 0) throw fail('GOOGLE_MAIL_BODY_UNAVAILABLE');
        budget.bytes += Buffer.byteLength(body?.data ?? '', 'base64url');
        if (budget.bytes > 128 * 1024) throw fail('GOOGLE_MATERIAL_LIMIT');
        return {...part, body};
    };
    return {...message, payload: await visit(message.payload)};
}
