import type { TwinDiscoveredSource, TwinSourceSpec } from './domain';

export interface TwinScanRules { include: string[]; exclude: string[]; selection?: boolean; }
export interface TwinScanRuleInput extends TwinScanRules {
    focus?: string;
    name: string; intervalMinutes: number; enabled: boolean;
    kinds?: import('./domain').TwinMemoryKind[];
}
const MAX_LINES = 200;
export function ruleLines(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MAX_LINES || value.some(line => typeof line !== 'string' || line.length > 500)) invalid();
    const lines = (value as string[]).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    for (const line of lines) {
        if ((line.includes(':') && !/^(project|file|local|remote|session|session-name|resource):.+$/.test(line)) || /[\[\]{}\\!\x00-\x1f]/.test(line) || line.slice(line.indexOf(':') + 1).split('/').includes('..')) invalid();
    }
    return [...new Set(lines)];
}
export function scanRules(value: unknown): TwinScanRules {
    if (!value || typeof value !== 'object') invalid();
    const rules = value as TwinScanRules;
    const include = ruleLines(rules.include);
    if (rules.selection !== undefined && (rules.selection !== true || include.length !== 1 || !include[0].startsWith('resource:'))) invalid();
    return { include, exclude: ruleLines(rules.exclude), ...(rules.selection ? { selection: true } : {}) };
}
export function matchesRules(resource: TwinDiscoveredSource, rules: TwinScanRules): boolean {
    return (!rules.include.length || rules.include.some(line => matchesLine(resource, line)))
        && !rules.exclude.some(line => matchesLine(resource, line));
}
export function matchesLine(resource: TwinDiscoveredSource, line: string): boolean {
    const colon = line.indexOf(':'), type = colon < 0 ? 'file' : line.slice(0, colon);
    const raw = colon < 0 ? line : line.slice(colon + 1);
    const pathRule = colon < 0 || type === 'local' || type === 'remote';
    const pattern = pathRule ? filePattern(raw) : raw;
    const values = matchValues(resource, type).map(value => pathRule ? value.replace(/^\//, '') : value);
    return values.some(value => glob(pattern, pathRule).test(value));
}
function matchValues(resource: TwinDiscoveredSource, type: string): string[] {
    if (type === 'resource') return [resourceKey(resource)];
    if (type === 'project') return [resource.projectId, resource.projectName ?? ''];
    if (type === 'session-name') return resource.kind === 'file' ? [] : [resource.label];
    if (type === 'session') return resource.kind === 'file' ? [] : [resource.label,
        `${resource.kind === 'session' ? 'native' : 'harness'}/${resource.profileId ? resource.profileId + '/' : ''}${resource.sessionId ?? resource.target}`];
    if (resource.kind !== 'file' || (['local', 'remote'].includes(type) && resource.location !== type)) return [];
    return [resource.path ?? resource.target, ...(resource.directoryPath ? [resource.directoryPath] : [])];
}
function filePattern(pattern: string): string {
    if (pattern.startsWith('/')) return pattern.slice(1);
    return pattern.replace(/\/$/, '').includes('/') ? pattern : '**/' + pattern;
}
function glob(pattern: string, descendants = false): RegExp {
    let source = '';
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index];
        if (char === '*' && pattern[index + 1] === '*') {
            index++;
            if (pattern[index + 1] === '/') { source += '(?:.*/)?'; index++; }
            else source += '.*';
        } else source += char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + source + (pattern.endsWith('/') ? '.*' : descendants ? '(?:/.*)?' : '') + '$');
}
function invalid(): never { throw new Error('TWIN_INVALID_SCAN_RULE'); }

export const resourceKey = (source: TwinSourceSpec): string => source.kind + '/' + encodeURIComponent(source.target).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
