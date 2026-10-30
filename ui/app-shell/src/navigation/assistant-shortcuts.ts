import {folderBrowserPath} from '@itookit/app-contracts';
import type {ProjectService} from '@itookit/app-contracts/services';

export type AssistantShortcutTarget = {kind: 'resource'; workspace: string; resource: string}
    | {kind: 'directory'; projectId: string; path: string} | {kind: 'newSession'; projectId: string}
    | {kind: 'scanner'; workspaceId: string; scannerId: string};
export interface AssistantShortcut {id: string; title: string; keywords?: string; context?: string; target: AssistantShortcutTarget}
export interface AssistantMenuState {version: 1; shortcuts: AssistantShortcut[]; seen: Record<string, string>}
export const ASSISTANT_MENU_DOCUMENT = 'nestos_assistant_menu_v1';
export function emptyAssistantState(): AssistantMenuState {return {version: 1, shortcuts: [], seen: {}};}
const text = (value: unknown, limit = 20000): value is string => typeof value === 'string' && value.length <= limit;
export function validShortcutTarget(target: unknown): target is AssistantShortcutTarget {
    if (!target || typeof target !== 'object') return false;
    const value = target as Record<string, unknown>;
    if (value.kind === 'resource') return text(value.workspace, 128) && /^[a-zA-Z0-9_-]+$/.test(value.workspace) && text(value.resource);
    if (value.kind === 'scanner') return text(value.workspaceId, 256) && !!value.workspaceId && text(value.scannerId, 256) && !!value.scannerId;
    if (!text(value.projectId, 256) || !value.projectId) return false;
    return value.kind === 'newSession' || value.kind === 'directory' && text(value.path, 4096)
        && !value.path.includes('\\') && !value.path.startsWith('/') && !value.path.split('/').some(part => ['.', '..', '.nestos'].includes(part));
}
export function readAssistantState(value: unknown): AssistantMenuState {
    if (value === undefined) return emptyAssistantState();
    const data = value as AssistantMenuState;
    if (data?.version !== 1 || !Array.isArray(data.shortcuts) || data.shortcuts.length > 50 || !data.seen || typeof data.seen !== 'object' || Array.isArray(data.seen)) throw new Error('ASSISTANT_SETTINGS_INVALID');
    const ids = new Set<string>();
    for (const item of data.shortcuts) {
        if (!item || !text(item.id, 128) || !item.id || ids.has(item.id) || !text(item.title, 160) || !item.title.trim() || !validShortcutTarget(item.target)) throw new Error('ASSISTANT_SHORTCUT_INVALID');
        if (item.keywords !== undefined && !text(item.keywords, 500) || item.context !== undefined && !text(item.context, 4096)) throw new Error('ASSISTANT_SHORTCUT_INVALID');
        ids.add(item.id);
    }
    if (Object.keys(data.seen).length > 2000 || Object.entries(data.seen).some(([key, value]) => !text(key, 1024) || !text(value, 1024))) throw new Error('ASSISTANT_SETTINGS_INVALID');
    return structuredClone(data);
}
export async function shortcutNavigation(target: AssistantShortcutTarget, projects: ProjectService): Promise<{target: string; resourceId?: string}> {
    if (!validShortcutTarget(target)) throw new Error('ASSISTANT_SHORTCUT_INVALID');
    if (target.kind === 'resource') return {target: target.workspace, resourceId: target.resource || undefined};
    if (target.kind === 'scanner') return {target: 'twin', resourceId: `/workspace/${encodeURIComponent(target.workspaceId)}/sources/${encodeURIComponent('plan:' + target.scannerId)}`};
    const project = await projects.get(target.projectId);
    if (target.kind === 'newSession') return {target: 'chat', resourceId: 'draft:' + project.project.id};
    return {target: 'chat', resourceId: folderBrowserPath(project.path) + '/@files' + (target.path ? '/' + target.path : '')};
}

/** Every whitespace-separated term must occur; matching is case/width insensitive. */
export function matchesShortcutQuery(query: string, values: readonly string[]): boolean {
    const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
    const corpus = normalize(values.join(' '));
    return normalize(query).trim().split(/\s+/u).filter(Boolean).every(term => corpus.includes(term));
}
export function shortcutSearchValues(item: AssistantShortcut): string[] {
    const target = item.target;
    const location = target.kind === 'directory' ? target.path : target.kind === 'resource' ? target.resource : '';
    return [item.title, item.keywords ?? '', item.context ?? '', location];
}
