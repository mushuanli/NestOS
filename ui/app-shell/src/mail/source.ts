import type {BrowserNode, BrowserSource} from '@itookit/vfs-ui';
import type {MailSnapshot} from './read';
import {t} from '@itookit/common';
export const mailLabel = (key: string) => t(('mail.' + key) as Parameters<typeof t>[0]);
export function mailNodes(snapshot: MailSnapshot, selected: string, viewId: string): BrowserNode[] {
    const sources = new Map(snapshot.sources.map(source => [source.id, source]));
    return snapshot.messages.filter(message => !selected || message.sourceId === selected).sort((a, b) => (b.date || b.modified) - (a.date || a.modified) || a.id.localeCompare(b.id))
        .map(message => ({id: message.id, parentId: null, kind: 'file', resource: {viewId, path: message.id}, readOnly: true, fileDetails: false,
            label: message.subject, description: [message.from, message.date ? new Date(message.date).toLocaleString() : '', sources.get(message.sourceId)?.account].filter(Boolean).join(' · '),
            modifiedAt: message.date || message.modified, titleLayout: 'stacked'}));
}
export function accountNodes(snapshot: MailSnapshot): BrowserNode[] {
    const nodes: BrowserNode[] = [{id: 'all', parentId: null, kind: 'file', readOnly: true, fileDetails: false, label: mailLabel('all'), description: String(snapshot.messages.length)}];
    const providers = new Map(snapshot.sources.map(source => [source.providerId, source.provider]));
    for (const [id, name] of providers) {
        const key = 'provider:' + id;
        nodes.push({id: key, parentId: null, kind: 'group', expandable: true, presentation: 'drawer', label: name, readOnly: true});
        for (const source of snapshot.sources.filter(source => source.providerId === id)) nodes.push({id: 'account:' + source.id, parentId: key, kind: 'file', label: source.account,
            readOnly: true, fileDetails: false, description: [source.name, String(snapshot.messages.filter(message => message.sourceId === source.id).length)].filter(Boolean).join(' · ')});
    }
    return nodes;
}
export function memorySource(nodes: () => BrowserNode[]): BrowserSource {
    return {get: async id => nodes().find(node => node.id === id), children: async parent => nodes().filter(node => node.parentId === parent), subscribe: () => () => {}};
}
