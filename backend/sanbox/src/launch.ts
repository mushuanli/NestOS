import { bubblewrapArgs } from './bubblewrap';
import { createSeatbeltProfile } from './seatbelt';
import { assertPath, validateCommand, validatePolicy } from './policy';
import { SandboxError, type SandboxBackend, type SandboxCommand, type SandboxLaunchPlan, type SandboxPolicy } from './types';

export function selectSandboxBackend(platform: string): SandboxBackend {
    if (platform === 'linux') return 'bubblewrap';
    if (platform === 'darwin') return 'seatbelt';
    throw new SandboxError('UNSUPPORTED_PLATFORM', `No system sandbox backend for ${platform}`);
}

export function createSandboxLaunchPlan(backend: SandboxBackend, policy: SandboxPolicy,
    request: SandboxCommand, executable?: string): SandboxLaunchPlan {
    if (backend !== 'seatbelt' && backend !== 'bubblewrap') throw new SandboxError('UNSUPPORTED_PLATFORM', `Unknown backend: ${backend}`);
    validatePolicy(policy);
    validateCommand(policy, request);
    const command = executable ?? (backend === 'seatbelt' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap');
    assertPath(command);
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', HOME: request.cwd };
    // Child overrides are applied after entering the sandbox, never to its launcher.
    const childEnv = { ...env, ...request.env };
    const child = ['/usr/bin/env', '-i', ...Object.entries(childEnv).map(([key, value]) => `${key}=${value}`),
        request.command, ...request.args ?? []];
    const args = backend === 'seatbelt' ? ['-p', createSeatbeltProfile(policy), ...child]
        : [...bubblewrapArgs(policy, request.cwd), ...child];
    return { backend, command, args, cwd: request.cwd, env };
}
