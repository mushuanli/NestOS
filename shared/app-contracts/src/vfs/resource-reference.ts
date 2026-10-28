export interface ResourceScope {navigation: string; projectId?: string; sessionId?: string}
export interface ResourceReference {navigation?: string; root: 'current' | 'navigation'; path: string}
export interface ResourceContent {reference: ResourceReference; scope: ResourceScope; path: string; text: string; bytes: number; sha256: string}
export const ResourceCommand = {Read: 'app.resource.read', Search: 'app.resource.search'} as const;

/** Presentation syntax only; authorization and mount binding belong to the host. */
export function parseResourceReference(input: string): ResourceReference {
    if (!input.startsWith('@')) throw new Error('RESOURCE_REFERENCE_REQUIRED');
    let text = input.slice(1);
    if (text.startsWith('"')) {
        try {text = JSON.parse(text);} catch {throw new Error('RESOURCE_REFERENCE_INVALID');}
    }
    const named = /^([a-z][a-z0-9-]*):\/(.*)$/.exec(text);
    const root = named || text.startsWith('//') ? 'navigation' : 'current';
    const path = named ? '/' + named[2] : text.startsWith('//') ? text.slice(1) : text;
    if (!path.startsWith('/') || /[\\\0\r\n]/.test(path) || path.split('/').includes('..')) throw new Error('RESOURCE_PATH_INVALID');
    return {root, ...(named ? {navigation: named[1]} : {}), path: '/' + path.split('/').filter(part => part && part !== '.').join('/')};
}
export function formatResourceReference(reference: ResourceReference): string {
    const text = reference.navigation ? `${reference.navigation}:${reference.path}`
        : `${reference.root === 'navigation' ? '/' : ''}${reference.path}`;
    return '@' + (/\s|["\\]/.test(text) ? JSON.stringify(text) : text);
}
export const InputSourceCommand = {Catalog: 'app.input-source.catalog', Execute: 'app.input-source.execute', Inspect: 'app.input-source.inspect'} as const;
export type ExecutableInputSource =
    | {kind: 'tool'; toolId: string; toolVersion: string; args: Record<string, import('@itookit/llm-flow/contracts').JsonValue>}
    | {kind: 'flow'; flowId: string; revision: number; digest: string; parameters: Record<string, import('@itookit/llm-flow/contracts').JsonValue>; connectionId?: string; connectionBindings?: Record<string, string>};
export interface InputSourceExecution {requestId: string; scope: ResourceScope; source: ExecutableInputSource}
export interface InputSourceReceipt {sessionId: string; taskId?: string}
