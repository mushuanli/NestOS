import { describe, expect, it } from 'vitest';
import { patchIdentityConfig } from '../src/flow/patch-identity';

describe('dynamic identity grants', () => {
    it('preserves nested declared grants and scheduling while accepting nested identity messages', () => {
        const leaf = { config: {}, capabilities: ['read'] };
        const original = { delegation: { enabled: true, fanout: { maxTasks: 1 }, template: {
            capabilities: ['write'], delegation: { enabled: true, template: leaf },
        } } };
        const resolved = { config: { messages: ['child'], delegation: { enabled: true, resolvedTemplate: {
            capabilities: ['admin'], config: { messages: ['grandchild'], toolIds: ['admin'], subtasks: { enabled: true } },
        } } }, capabilities: ['admin'] };
        const result = patchIdentityConfig(original, { delegation: { enabled: true, fanout: { maxTasks: 99 },
            resolvedTemplate: resolved } }, []) as any;
        const child = result.delegation.resolvedTemplate;
        expect(result.delegation.fanout.maxTasks).toBe(1);
        expect(child.capabilities).toEqual(['write']);
        expect(child.config.messages).toEqual(['child']);
        const grandchild = child.config.delegation.resolvedTemplate;
        expect(grandchild.capabilities).toEqual(['read']);
        expect(grandchild.config).toMatchObject({ messages: ['grandchild'], toolIds: ['read'], subtasks: null });
        expect(original.delegation.template).not.toHaveProperty('resolvedTemplate');
    });
});
