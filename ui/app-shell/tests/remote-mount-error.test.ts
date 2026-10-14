import { expect, it } from 'vitest';
import { FSError } from '@itookit/vfs-core';
import { RemoteConnectionUnavailableError } from '@itookit/app-core';
import { localizeMountError } from '../src/files/localize-mount-error';

it('shows a named, actionable cause even when a missing connection is wrapped by VFS', () => {
    const source = new RemoteConnectionUnavailableError({connectionId: 'private-uuid', connectionName: 'Office',
        reason: 'extension-missing', revision: 1, configured: []}, ['project-id']);
    const wrapper = new FSError('EACCES', 'View access failed'); wrapper.cause = source;
    const localized = localizeMountError(wrapper) as Error;
    expect(localized.message).toContain('Office'); expect(localized.message).toContain('pi-agent');
    expect(localized.message).not.toContain('private-uuid'); expect(localized.message).not.toContain('Remote file system');
});

it('distinguishes a deleted MCP binding from missing server files', () => {
    const source = new RemoteConnectionUnavailableError({connectionId: 'deleted', reason: 'mcp-not-found', revision: 1, configured: []}, []);
    expect((localizeMountError(source) as Error).message).toContain('MCP');
    const missingFile = new FSError('ENOENT', 'Remote file missing'); expect(localizeMountError(missingFile)).toBe(missingFile);
});
