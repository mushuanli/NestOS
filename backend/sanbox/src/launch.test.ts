import { describe, expect, it } from 'vitest';
import { createSandboxLaunchPlan, createSeatbeltProfile, selectSandboxBackend } from './index';

const policy = { readOnlyPaths: ['/input'], writablePaths: ['/workspace'] };
const request = { command: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'], cwd: '/workspace' };

describe('sandbox launch boundary', () => {
    it('selects only supported operating systems', () => {
        expect(selectSandboxBackend('linux')).toBe('bubblewrap');
        expect(selectSandboxBackend('darwin')).toBe('seatbelt');
        expect(() => selectSandboxBackend('win32')).toThrow('No system sandbox');
    });

    it('isolates namespaces and mounts only explicit grants and runtime paths', () => {
        const plan = createSandboxLaunchPlan('bubblewrap', policy, request);
        expect(plan.command).toBe('/usr/bin/bwrap');
        expect(plan.args).toEqual(expect.arrayContaining(['--unshare-net', '--unshare-user', '--unshare-pid', '--new-session']));
        const joined = plan.args.join('\n');
        expect(joined).toContain('--ro-bind\n/input\n/input');
        expect(joined).toContain('--bind\n/workspace\n/workspace');
        expect(plan.args.slice(-3)).toEqual(['/bin/sh', '-c', request.args[1]]);
        expect(plan.env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', HOME: '/workspace' });
    });

    it('requires explicit network permission on both backends', () => {
        expect(createSandboxLaunchPlan('bubblewrap', { ...policy, network: 'allow' }, request).args).not.toContain('--unshare-net');
        expect(createSeatbeltProfile(policy)).not.toContain('(allow network*)');
        expect(createSeatbeltProfile({ ...policy, network: 'allow' })).toContain('(allow network*)');
    });

    it('keeps command arguments and child environment out of the launcher policy', () => {
        const args = ['$(touch /tmp/escape)', '"; --share-net', '\n(allow default)'];
        for (const backend of ['seatbelt', 'bubblewrap'] as const) {
            const plan = createSandboxLaunchPlan(backend, policy, { ...request, args, env: { LD_PRELOAD: '/workspace/lib.so' } });
            expect(plan.env).not.toHaveProperty('LD_PRELOAD');
            expect(plan.args.slice(-3)).toEqual(args);
            expect(plan.args).toContain('LD_PRELOAD=/workspace/lib.so');
        }
    });

    it('escapes Seatbelt path literals', () => {
        const profile = createSeatbeltProfile({ writablePaths: ['/work/"quoted"\\name'] });
        expect(profile).toContain('(deny default)');
        expect(profile).not.toContain('(subpath "/System")');
        expect(profile).not.toContain('(subpath "/System/Volumes/Data")');
        expect(profile).toContain('(subpath "/work/\\"quoted\\"\\\\name")');
        expect(profile).not.toContain('(allow default)');
    });

    it.each(['relative', '/', '/workspace/..', '/workspace//sub', '/workspace/', '/workspace/\nattack'])('rejects malformed grants: %s', path => {
        expect(() => createSeatbeltProfile({ writablePaths: [path] })).toThrow();
    });

    it.each(['/proc', '/dev', '/sys', '/usr/local', '/tmp', '/private'])('rejects reserved writable grants: %s', path => {
        expect(() => createSeatbeltProfile({ writablePaths: [path] })).toThrow();
    });

    it('rejects unauthorized cwd, ambiguous grants and malformed runtime values', () => {
        expect(() => createSandboxLaunchPlan('bubblewrap', policy, { ...request, cwd: '/workspace-evil' })).toThrow();
        expect(() => createSeatbeltProfile({ writablePaths: ['/workspace'], readOnlyPaths: ['/workspace/secrets'] })).toThrow();
        expect(() => createSandboxLaunchPlan('bubblewrap', policy, { ...request, env: { 'BAD=KEY': 'x' } })).toThrow();
        expect(() => createSandboxLaunchPlan('bubblewrap', policy, { ...request, args: ['a\0b'] })).toThrow();
        expect(() => createSeatbeltProfile({ network: 'invalid' as 'deny' })).toThrow();
    });
});
