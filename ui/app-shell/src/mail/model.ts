export interface MailSource {id: string; name: string; providerId: string; provider: string; accountId: string; account: string}
export interface MailMessage {id: string; sourceId: string; subject: string; from: string; to: string; date: number; modified: number; size: number; version: string}
export interface MailDocument {subject: string; from: string; to: string; date: number; body: string}
export function parseMail(content: string, fallback: string): MailDocument {
    const boundary = content.search(/\r?\n\r?\n/), header = boundary < 0 ? '' : content.slice(0, boundary);
    const headers = new Map<string, string>();
    for (const line of header.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const colon = line.indexOf(':'); if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    const date = Date.parse(headers.get('date') ?? '');
    return {subject: headers.get('subject') || fallback, from: headers.get('from') ?? '', to: headers.get('to') ?? '',
        date: Number.isFinite(date) ? date : 0, body: headers.size ? content.slice(boundary).replace(/^\r?\n\r?\n/, '') : content};
}
export function parseMailSource(content: string, directory: string): MailSource {
    const value = JSON.parse(content);
    if (value?.format !== 'nestos.mail-source' || value.version !== 1 || !value.provider || !value.account
        || ![value.provider.id, value.provider.name, value.account.id, value.account.name].every(item => typeof item === 'string' && item.length > 0 && item.length <= 300))
        throw new Error('MAIL_SOURCE_INVALID');
    return {id: directory, name: typeof value.name === 'string' ? value.name.slice(0, 300) : '',
        providerId: value.provider.id, provider: value.provider.name, accountId: value.account.id, account: value.account.name};
}
