import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { LocalApplicationPort } from '../src/application';
import { ApplicationConfiguration } from '../src/application/configuration';
import { validateApplicationCommand, validateApplicationQuery } from '../src/application/validation';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('application configuration capability', () => {
    it('waits for driver readiness at use time, preserving the service receiver', async () => {
        let release!: () => void;
        const readiness = new Promise<void>(resolve => { release = resolve; });
        const service = { init: vi.fn(async () => {}), getProviders: vi.fn(function (this: unknown) { expect(this).toBe(service); return []; }) };
        const capability = new ApplicationConfiguration(service as unknown as IAgentManagementService, () => readiness);
        const pending = capability.invoke({ operation: 'getProviders', args: [] });
        await Promise.resolve(); expect(service.init).not.toHaveBeenCalled(); expect(service.getProviders).not.toHaveBeenCalled();
        release(); expect(await pending).toEqual([]); expect(service.init).not.toHaveBeenCalled();
    });
    it('rejects arbitrary methods, mutation queries, read commands and malformed arity', () => {
        for (const operation of ['dispose', 'init', 'recordCost', '__proto__', 'saveProvider'])
            expect(() => validateApplicationQuery('configuration', { operation, args: [] })).toThrow();
        expect(() => validateApplicationCommand('configuration', { operation: 'getProviders', args: [] })).toThrow();
        expect(() => validateApplicationCommand('configuration', { operation: 'deleteAgent', args: [] })).toThrow();
        expect(() => validateApplicationQuery('configuration', { operation: 'getProviders', args: ['unexpected'] })).toThrow();
        expect(() => validateApplicationCommand('configuration', { operation: 'saveAgent', args: [{ id: '../outside' }] })).toThrow();
    });
    it('persists a prompt through the domain service and broadcasts changes to other clients', async () => {
        const owner = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false });
        cleanup.push(() => owner.dispose());
        const writer = new LocalApplicationPort(owner, ['minds']), reader = new LocalApplicationPort(owner, ['minds']);
        cleanup.push(() => reader.close(), () => writer.close());
        const event = vi.fn(); reader.subscribe(event);
        const prompt = { id: 'remote-prompt', name: 'Remote prompt', content: ['Use plain language'], createdAt: Date.now(), modifiedAt: Date.now() };
        await writer.command('configuration', { operation: 'saveSystemPrompt', args: [prompt] });
        expect(await reader.query('configuration', { operation: 'getSystemPrompt', args: [prompt.id] })).toMatchObject(prompt);
        expect(event).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invalidate', scope: 'configuration' }));
        await writer.command('configuration', { operation: 'deleteSystemPrompt', args: [prompt.id] });
        expect(await reader.query('configuration', { operation: 'getSystemPrompt', args: [prompt.id] })).toBeNull();
        await writer.close(); expect(await reader.query('configuration', { operation: 'getProviders', args: [] })).toBeInstanceOf(Array);
    });
});
