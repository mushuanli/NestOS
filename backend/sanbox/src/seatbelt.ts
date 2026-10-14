import type { SandboxPolicy } from './types';
import { validatePolicy } from './policy';
import runtime from './runtime-policy.json';

/** SBPL strings require escaping independently of shell/JSON argument transport. */
function quote(path: string): string {
    return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function createSeatbeltProfile(policy: SandboxPolicy): string {
    validatePolicy(policy);
    const read = [...new Set([...runtime.seatbelt.runtimePaths, ...policy.readOnlyPaths ?? [], ...policy.writablePaths ?? []])];
    const rules = [...runtime.seatbelt.rules];
    for (const path of read) rules.push(`(allow file-read* file-map-executable (subpath ${quote(path)}))`);
    for (const path of new Set(policy.writablePaths ?? [])) rules.push(`(allow file-write* (subpath ${quote(path)}))`);
    if (policy.network === 'allow') rules.push('(allow network*)');
    return rules.join('\n');
}
