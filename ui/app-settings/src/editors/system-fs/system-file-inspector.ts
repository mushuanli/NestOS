import { createFileSystemSource, createFileSystemView, MemoryBackend } from '@itookit/vfs-core';
import type { WorkspaceFileSource } from '@itookit/app-contracts/settings';

/** Reuse the normal view protocol; the inspector has no alternate ID/path parser. */
export async function createSystemFileInspector(sources: readonly WorkspaceFileSource[], devices: readonly import('@itookit/app-contracts/services').DeviceDescription[]) {
    const descriptions = await createFileSystemSource({ backend: new MemoryBackend(), viewId: 'device-descriptions', internal: true });
    try {
        for (const device of devices) {
            if (!/^[a-zA-Z0-9_-]+$/.test(device.handlerId)) continue;
            await descriptions.fs.driver.createFile({ name: `${device.handlerId}.json`, parentPath: '/',
                content: JSON.stringify({ id: device.handlerId, description: device.description,
                    writable: device.writable, streamable: device.streamable, sessionable: device.sessionable }, null, 2) });
        }
        const view = createFileSystemView({ viewId: 'system-file-inspector', mounts: [
            { mountId: 'devices', at: '/dev', fs: descriptions.fs, access: 'ro' },
            ...sources.map(source => ({ mountId: `workspace:${source.name}`, at: `/workspaces/${source.name}`, fs: source.fs, access: 'ro' as const })),
        ] });
        return { fs: view, dispose: async () => { await view.dispose(); await descriptions.dispose(); } };
    } catch (error) { await descriptions.dispose(); throw error; }
}
