import {digest} from './sync-store.mjs';

/** Safe structural evidence only; never retain headers, body data or attachment IDs. */
export function bodyDiagnostic(message, part, partPath, phase) {
    const body = part?.body;
    return {messageKey: digest(String(message.id)), partPath, phase,
        mimeType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(part?.mimeType ?? '') ? part.mimeType : 'unknown',
        bodyPresent: !!body, dataPresent: typeof body?.data === 'string',
        attachmentPresent: typeof body?.attachmentId === 'string',
        declaredBytes: Number.isSafeInteger(body?.size) && body.size >= 0 ? body.size : null};
}
