import { t } from '@itookit/common';
import type { ConversationControls } from '@itookit/ui-common';
type Attachment = NonNullable<Parameters<ConversationControls['send']>[1]>[number];

/** Browser bytes are transmitted inline; callers cannot nominate a server path or URL. */
export async function prepareRemoteAttachments(files: File[], allowed: Array<'text' | 'image'>): Promise<Attachment[]> {
    if (files.length > 5) throw new Error(t('harness.attachmentCapacity'));
    const attachments: Attachment[] = []; let total = 0;
    for (const file of files) {
        if (!file.name || /[\x00-\x1f\x7f/\\]/.test(file.name) || new TextEncoder().encode(file.name).byteLength > 256 || file.size > 256 * 1024)
            throw new Error(t('harness.attachmentCapacity'));
        const bytes = new Uint8Array(await file.arrayBuffer());
        const kind = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? 'image' : 'text';
        if (!allowed.includes(kind)) throw new Error(t('harness.remoteAttachments'));
        let content: string;
        if (kind === 'image') content = image(bytes, file.type);
        else {
            if (bytes.byteLength > 64 * 1024) throw new Error(t('harness.attachmentCapacity'));
            try { content = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { throw new Error(t('harness.attachmentType')); }
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) || file.type && !file.type.startsWith('text/') && !['application/json', 'application/xml'].includes(file.type)) throw new Error(t('harness.attachmentType'));
        }
        total += new TextEncoder().encode(content).byteLength;
        if (total > 512 * 1024) throw new Error(t('harness.attachmentCapacity'));
        attachments.push({kind, name: file.name, content, ...(kind === 'image' ? {mimeType: file.type} : {})});
    }
    return attachments;
}
function image(bytes: Uint8Array, mime: string): string {
    const prefix = [...bytes.subarray(0, 12)];
    const valid = mime === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => prefix[index] === byte)
        : mime === 'image/jpeg' ? prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255
        : new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
    if (!valid) throw new Error(t('harness.attachmentType'));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return `data:${mime};base64,${btoa(binary)}`;
}
