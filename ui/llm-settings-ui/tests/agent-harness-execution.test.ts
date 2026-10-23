// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { renderAgentExecution, bindAgentExecution, readAgentExecution } from '../src/editors/agent-execution';

const agent: AgentDefinition = { id: 'a', name: 'Remote reviewer', type: 'agent', config: {},
    execution: { kind: 'harness', connectionId: 'remote' } };
const controllers: ReturnType<typeof bindAgentExecution>[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function form(list: () => Promise<Array<{ id: string; name: string; enabled?: boolean }>>, source = agent) {
    const root = document.createElement('div'); document.body.append(root);
    root.innerHTML = renderAgentExecution(source, [], []);
    const controller = bindAgentExecution(root, source, [], { listHarnessConnections: list }); controllers.push(controller);
    await controller.ready();
    return { root, controller };
}

it('retains a harness binding and renders only safe connection names without a model catalog', async () => {
    const { root } = await form(async () => [{ id: 'remote', name: '<img src=x onerror=bad()>' }]);
    expect(root.querySelector<HTMLSelectElement>('[name=executionKind]')!.value).toBe('harness');
    expect(root.querySelector<HTMLFieldSetElement>('[data-agent-harness-fields]')!.disabled).toBe(false);
    expect(root.querySelector<HTMLFieldSetElement>('[data-agent-flow-fields]')!.disabled).toBe(true);
    expect(root.querySelector('[name=executionHarnessConnection] img')).toBeNull();
    expect(readAgentExecution(root)).toEqual({ kind: 'harness', connectionId: 'remote' });
});

it.each([{ entries: [] }, { entries: [{ id: 'remote', name: 'Remote', enabled: false }] }])('preserves an unavailable binding but prevents saving it', async ({ entries }) => {
    const { root } = await form(async () => entries);
    expect(root.querySelector<HTMLSelectElement>('[name=executionHarnessConnection]')!.value).toBe('remote');
    expect(() => readAgentExecution(root)).toThrow();
});

it('preserves the form when catalog loading fails and allows switching to a local Agent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root, controller } = await form(async () => { throw new Error('private endpoint details'); });
    expect(() => readAgentExecution(root)).toThrow();
    expect(root.textContent).not.toContain('private endpoint details');
    const select = root.querySelector<HTMLSelectElement>('[name=executionKind]')!;
    select.value = 'agent'; select.dispatchEvent(new Event('change', { bubbles: true })); await controller.ready();
    expect(readAgentExecution(root)).toEqual({ kind: 'agent' });
    expect(root.querySelector<HTMLFieldSetElement>('[data-agent-harness-fields]')!.disabled).toBe(true);
});
