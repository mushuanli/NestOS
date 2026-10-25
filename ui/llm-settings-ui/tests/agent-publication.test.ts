// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {getLogger} from '@itookit/common';
import {AgentPublicationController} from '../src/editors/agent-publication';
import {AgentConfigEditor} from '../src/editors/AgentConfigEditor';
import type {AgentPublishedRevision, AgentPublicationStatus} from '@itookit/kernel-adapters/contracts';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanups.splice(0)) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); getLogger().clear();});
function revision(digest = 'b'.repeat(64)): AgentPublishedRevision {
    return {schemaVersion: 1, target: {kind: 'agent', id: 'agent', version: `ap1_${digest}`, digest}, sourceDigest: 'a'.repeat(64), createdAt: 1,
        definition: {id: 'agent', name: 'Agent', type: 'agent', config: {systemPrompt: 'PRIVATE_POLICY_BODY'}}};
}
function setup() {
    const root = document.createElement('div'); document.body.append(root);
    const state: AgentPublicationStatus = {sourceDigest: 'a'.repeat(64), draftDigest: 'b'.repeat(64), hasDraftChanges: true};
    const service = {getAgentPublicationStatus: vi.fn(async () => structuredClone(state)), getAgentPublicationReceipt: vi.fn(async (_request: unknown): Promise<AgentPublishedRevision | null> => null),
        publishAgent: vi.fn(async (request: any) => ({...revision(request.expectedRevisionDigest), sourceDigest: request.expectedSourceDigest}))};
    const flush = vi.fn(async () => {}), controller = new AgentPublicationController(root, service as never, 'agent', flush, false);
    cleanups.push(() => controller.destroy());
    const publish = root.querySelector<HTMLButtonElement>('[data-agent-publish]')!, inspect = root.querySelector<HTMLButtonElement>('[data-agent-publication-inspect]')!;
    return {root, state, service, flush, controller, publish, inspect};
}

it('reads status without publishing and flushes the editable draft before freezing its publication request', async () => {
    const f = setup(); await vi.waitFor(() => expect(f.root.textContent).toContain('兼容配置'));
    expect(f.service.publishAgent).not.toHaveBeenCalled(); const order: string[] = [];
    f.flush.mockImplementation(async () => {order.push('save');});
    f.service.publishAgent.mockImplementation(async () => {order.push('publish'); return revision();});
    f.publish.click(); await vi.waitFor(() => expect(f.root.textContent).toContain('本次已发布'));
    expect(order).toEqual(['save', 'publish']); expect(f.service.publishAgent).toHaveBeenCalledWith({agentId: 'agent', operationId: expect.any(String),
        expectedSourceDigest: 'a'.repeat(64), expectedRevisionDigest: 'b'.repeat(64), expectedPublishedVersion: null});
    expect(() => f.controller.assertCanClose()).not.toThrow();
});

it('reconciles acceptance while the publication Promise is suspended and fences its late response from a newer operation', async () => {
    const f = setup(); let first!: (value: AgentPublishedRevision) => void, second!: (value: AgentPublishedRevision) => void;
    f.service.publishAgent.mockImplementationOnce(() => new Promise(resolve => {first = resolve;}));
    f.publish.click(); await vi.waitFor(() => expect(first).toBeTypeOf('function'));
    expect(f.publish.disabled).toBe(true); expect(f.inspect.disabled).toBe(false);
    f.service.getAgentPublicationReceipt.mockResolvedValueOnce(revision()); f.inspect.click();
    await vi.waitFor(() => expect(f.publish.disabled).toBe(false)); expect(() => f.controller.assertCanClose()).not.toThrow();
    f.state.latest = {target: revision().target, createdAt: 1}; f.state.draftDigest = 'c'.repeat(64);
    f.service.publishAgent.mockImplementationOnce(() => new Promise(resolve => {second = resolve;})); f.publish.click();
    await vi.waitFor(() => expect(second).toBeTypeOf('function')); first(revision()); await Promise.resolve();
    expect(f.publish.disabled).toBe(true); expect(() => f.controller.assertCanClose()).toThrow('尚未确认');
    second(revision('c'.repeat(64))); await vi.waitFor(() => expect(f.publish.disabled).toBe(false));
    expect(f.service.publishAgent.mock.calls[1][0]).not.toEqual(f.service.publishAgent.mock.calls[0][0]);
});

it('retains unknown identity, checks its receipt and retries the frozen request without rereading newer draft defaults', async () => {
    const f = setup(); f.service.publishAgent.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_TRANSPORT_DETAIL'), {code: 'OFFLINE'}));
    f.publish.click(); await vi.waitFor(() => expect(f.root.textContent).toContain('OFFLINE'));
    expect(() => f.controller.assertCanClose()).toThrow('尚未确认'); const original = structuredClone(f.service.publishAgent.mock.calls[0][0]);
    f.state.sourceDigest = 'c'.repeat(64); f.publish.click(); await vi.waitFor(() => expect(f.root.textContent).toContain('本次已发布'));
    expect(f.service.publishAgent.mock.calls[1][0]).toEqual(original); expect(f.flush).toHaveBeenCalledOnce();
    expect(JSON.stringify(getLogger().query({modules: ['agent-publication']}))).not.toContain('PRIVATE_TRANSPORT_DETAIL');
    expect(JSON.stringify(getLogger().query({modules: ['agent-publication']}))).not.toContain('PRIVATE_POLICY_BODY');
});

it('cancels preparation before dispatch when its editor is destroyed and does not republish from a late status read', async () => {
    const f = setup(); let flush!: () => void;
    f.flush.mockImplementation(() => new Promise(resolve => {flush = resolve;})); f.publish.click();
    await vi.waitFor(() => expect(flush).toBeTypeOf('function')); f.controller.destroy(); flush(); await Promise.resolve();
    expect(f.service.publishAgent).not.toHaveBeenCalled();
});

it('releases a definitively rejected attempt so the next click can review a fresh draft and dependency digest', async () => {
    const f = setup(); f.service.publishAgent.mockRejectedValueOnce(Object.assign(new Error('Changed'), {code: 'AGENT_SOURCE_CHANGED', outcome: 'not-committed'}));
    f.publish.click(); await vi.waitFor(() => expect(f.root.textContent).toContain('AGENT_SOURCE_CHANGED'));
    expect(() => f.controller.assertCanClose()).not.toThrow(); f.state.sourceDigest = 'c'.repeat(64); f.publish.click();
    await vi.waitFor(() => expect(f.root.textContent).toContain('本次已发布'));
    expect(f.service.publishAgent.mock.calls[1][0]).toMatchObject({expectedSourceDigest: 'c'.repeat(64)});
});

it('does not create an unknown-write lock when the initial read-only receipt query fails', async () => {
    const f = setup(); f.service.getAgentPublicationReceipt.mockRejectedValueOnce(Object.assign(new Error('Receipt transport down'), {code: 'OFFLINE'}));
    f.publish.click(); await vi.waitFor(() => expect(f.root.textContent).toContain('OFFLINE'));
    expect(f.service.publishAgent).not.toHaveBeenCalled(); expect(() => f.controller.assertCanClose()).not.toThrow();
    f.publish.click(); await vi.waitFor(() => expect(f.root.textContent).toContain('本次已发布'));
});

it('retains an uncertain operation when the returned receipt identifies another published target', async () => {
    const f = setup(); f.service.publishAgent.mockResolvedValueOnce({...revision(), target: {...revision().target, id: 'other-agent'}});
    f.publish.click(); await vi.waitFor(() => expect(f.root.textContent).toContain('AGENT_PUBLICATION_RECEIPT_INVALID'));
    expect(() => f.controller.assertCanClose()).toThrow('尚未确认');
    f.service.getAgentPublicationReceipt.mockResolvedValueOnce(revision()); f.inspect.click();
    await vi.waitFor(() => expect(f.root.textContent).toContain('本次已发布')); expect(() => f.controller.assertCanClose()).not.toThrow();
});

it('mounts publication controls in the real Agent editor without executing or opening a conversation', async () => {
    const root = document.createElement('div'); document.body.append(root); const published = revision();
    const service = {getAgentPublicationStatus: async () => ({sourceDigest: published.sourceDigest, draftDigest: published.target.digest, hasDraftChanges: true}),
        getAgentPublicationReceipt: async () => null, publishAgent: vi.fn(async () => published), listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [], saveAgent: vi.fn(async () => {})};
    const open = vi.fn(), editor = new AgentConfigEditor(root, {target: {kind: 'entity', entityType: 'agent', id: 'agent'}, onStartConversation: open} as never, service as never);
    cleanups.push(() => editor.destroy()); await editor.init(root, JSON.stringify(published.definition));
    root.querySelector<HTMLButtonElement>('[data-agent-publish]')!.click();
    await vi.waitFor(() => expect(service.publishAgent).toHaveBeenCalledOnce()); expect(open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(root.querySelector('[data-agent-publication]')!.textContent).toContain('本次已发布'));
});

it('protects the real editor model from source refreshes while its publication identity is unresolved', async () => {
    const root = document.createElement('div'); document.body.append(root); const published = revision();
    let finish!: (value: AgentPublishedRevision) => void, receipt: AgentPublishedRevision | null = null;
    const service = {getAgentPublicationStatus: async () => ({sourceDigest: published.sourceDigest, draftDigest: published.target.digest, hasDraftChanges: true}),
        getAgentPublicationReceipt: async () => receipt, publishAgent: async () => new Promise<AgentPublishedRevision>(resolve => {finish = resolve;}),
        listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [], saveAgent: vi.fn(async () => {})};
    const editor = new AgentConfigEditor(root, {target: {kind: 'entity', entityType: 'agent', id: 'agent'}} as never, service as never);
    cleanups.push(() => editor.destroy()); await editor.init(root, JSON.stringify(published.definition));
    root.querySelector<HTMLButtonElement>('[data-agent-publish]')!.click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    editor.setText(JSON.stringify({...published.definition, name: 'Late source refresh'}));
    expect(JSON.parse(editor.getText()).name).toBe('Agent'); expect(root.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('Agent');
    receipt = published; root.querySelector<HTMLButtonElement>('[data-agent-publication-inspect]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-agent-publication]')!.textContent).toContain('本次已发布')); finish(published);
    expect(root.querySelector('[data-agent-publication]')!.textContent).toContain('重新打开');
    expect(root.querySelector<HTMLButtonElement>('[data-agent-publish]')!.disabled).toBe(true);
});
