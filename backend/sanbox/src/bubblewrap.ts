import type { SandboxPolicy } from './types';
import runtime from './runtime-policy.json';

export function bubblewrapArgs(policy: SandboxPolicy, cwd: string): string[] {
    const args = [...runtime.linux.args];
    if (policy.network !== 'allow') args.push('--unshare-net');
    for (const path of runtime.linux.runtimePaths) args.push('--ro-bind-try', path, path);
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
    if (policy.network === 'allow') {
        for (const path of runtime.linux.networkPaths) args.push('--ro-bind-try', path, path);
    }
    const grants = [
        ...new Set(policy.readOnlyPaths ?? []), ...new Set(policy.writablePaths ?? []),
    ].sort((a, b) => a.length - b.length);
    for (const path of grants) args.push(policy.writablePaths?.includes(path) ? '--bind' : '--ro-bind', path, path);
    args.push('--chdir', cwd, '--');
    return args;
}
