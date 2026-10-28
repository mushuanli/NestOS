import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {DigitalTwinService} from '../src/digital-twin/service';

it('isolates private workspaces and shares an organization store only through a host-authorized binding', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/');
    let authorized = true, reads = 0;
    const services: DigitalTwinService[] = [];
    const open = (twinId: string, ownerId: string) => {
        const service = new DigitalTwinService({fs, workspace: {twinId, ownerId, authorize: async () => {
            if (!authorized) throw new Error('WORKSPACE_ACCESS_REVOKED');
        }}, reader: {sessions: async () => [], read: async () => {reads++; return {text: '', hash: '', nativeIdentity: ''};}},
        extractor: {run: async () => ({candidates: [], tokens: 0}), cancel: async () => {}, cleanup: async () => {}}, deleteSession: async () => {}});
        services.push(service); return service;
    };
    try {
        const personal = open('user-alice', 'user:alice'), org = open('org-team', 'organization:team');
        await personal.addMemory({content: 'Private knowledge'});
        await org.addMemory({content: 'Team knowledge'});
        const anotherMember = open('org-team', 'organization:team');
        expect((await anotherMember.snapshot()).memories.map(row => row.data.content)).toEqual(['Team knowledge']);
        expect((await personal.snapshot()).memories.map(row => row.data.content)).toEqual(['Private knowledge']);
        await expect(open('org-team', 'user:bob').snapshot()).rejects.toThrow('Twin owner denied');
        authorized = false;
        await expect(anotherMember.snapshot()).rejects.toThrow('WORKSPACE_ACCESS_REVOKED');
        await expect(anotherMember.addMemory({content: 'Denied'})).rejects.toThrow('WORKSPACE_ACCESS_REVOKED');
        await expect(anotherMember.previewSource({kind: 'file', target: 'secret', label: ''})).rejects.toThrow('WORKSPACE_ACCESS_REVOKED');
        expect(reads).toBe(0);
    } finally {await Promise.all(services.map(service => service.dispose())); await manager.dispose();}
});
