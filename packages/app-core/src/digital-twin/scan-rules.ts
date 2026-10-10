import type { TwinDiscoveredSource } from './domain';

export interface TwinScanRules { include: string[]; exclude: string[]; }
export interface TwinScanRuleInput extends TwinScanRules {
    name: string; intervalMinutes: number; enabled: boolean;
    kinds?: import('./domain').TwinMemoryKind[];
}
const MAX_LINES = 200;
export function ruleLines(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > MAX_LINES || value.some(line => typeof line !== 'string' || line.length > 500)) invalid();
    const lines = (value as string[]).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    for (const line of lines) {
        if (!/^(project|file|session):.+$/.test(line) || /[\[\]{}\\!\x00-\x1f]/.test(line) || line.slice(line.indexOf(':') + 1).split('/').includes('..')) invalid();
    }
    return [...new Set(lines)];
}
export function scanRules(value: unknown): TwinScanRules {
    if (!value || typeof value !== 'object') invalid();
    const rules = value as TwinScanRules;
    return { include: ruleLines(rules.include), exclude: ruleLines(rules.exclude) };
}
export function matchesRules(resource: TwinDiscoveredSource, rules: TwinScanRules): boolean {
    return (!rules.include.length || rules.include.some(line => matchesLine(resource, line)))
        && !rules.exclude.some(line => matchesLine(resource, line));
}
export function matchesLine(resource: TwinDiscoveredSource, line: string): boolean {
    const colon = line.indexOf(':'), type = line.slice(0, colon), pattern = line.slice(colon + 1);
    const value = type === 'project' ? resource.projectId : type === 'file' && resource.kind === 'file' ? resource.path
        : type === 'session' && resource.kind !== 'file' ? `${resource.kind === 'session' ? 'native' : 'harness'}/${resource.profileId ? resource.profileId + '/' : ''}${resource.sessionId ?? resource.target}` : undefined;
    return (value !== undefined && glob(pattern).test(value)) || (type === 'project' && Boolean(resource.projectName && glob(pattern).test(resource.projectName)));
}
function glob(pattern: string): RegExp {
    let source = '';
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index];
        if (char === '*' && pattern[index + 1] === '*') {
            index++;
            if (pattern[index + 1] === '/') { source += '(?:.*/)?'; index++; }
            else source += '.*';
        } else source += char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + source + (pattern.endsWith('/') ? '.*' : '') + '$');
}
function invalid(): never { throw new Error('TWIN_INVALID_SCAN_RULE'); }
