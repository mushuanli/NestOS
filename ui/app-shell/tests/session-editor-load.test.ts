// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVFS, MemoryBackend, type IStorageBackend } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeFsOps } from '@itookit/vfsdriver-local/node';
import { Kernel } from '@itookit/durable-kernel';
import { SessionRepository, SessionManager, SessionCommand } from '@itookit/llm-session';
import { SessionDirectoryStorageResolver } from '../../../backend/llm-session/src/persistence/session-directory-storage';
import { createLLMFactory } from '../../llm-ui/src/chat';
import { LLMWorkspaceEditor } from '../../llm-ui/src/shell/LLMWorkspaceEditor';
import type { ICommandBus } from '@itookit/llm-session/contracts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

it('requires an injected view even when another session instance exists', async () => {
    const f = await fixture();
    expect(() => new LLMWorkspaceEditor(document.createElement('div'), {
        sessionId: f.id, sessionRepository: f.repository, agentService: f.agents as never,
    })).toThrow('Chat editor requires an injected session view');
});

async function fixture(backend: IStorageBackend = new MemoryBackend()) {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    HTMLElement.prototype.scrollTo = vi.fn();
    const { manager } = await createVFS({ rootBackend: backend });
    cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    const kernel = new Kernel({ catalog: { fs }, pollMs: 0 });
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs)); await kernel.initialize();
    cleanup.push(async () => { kernel.dispose(); await kernel.waitIdle(); });
    const agents = { listAgents: () => [], getDefaultConnection: async () => null, getConnections: vi.fn(async () => []), findAgent: () => undefined, onChange: () => () => {} };
    const sessions = new SessionManager(repository, agents as never, { kernel, dagPlugins: {} as never, flowStore: {} as never });
    cleanup.push(() => sessions.destroy());
    const execute = vi.fn(async (command: string, args?: any) => {
        switch (command) {
            case SessionCommand.Bind: return sessions.bindSession(args.sessionId);
            case SessionCommand.GetSnapshot: return sessions.getSnapshot();
            case SessionCommand.GetSessions: return sessions.getSessions();
            case SessionCommand.GetSettings: return sessions.getSessionSettings();
            case SessionCommand.SaveSettings: return sessions.saveSessionSettings(args);
            case 'vcs.branch.switch': return sessions.switchBranch(args.branchName);
            case 'vcs.branch.list': return sessions.listBranches();
            default: return [];
        }
    });
    const commandBus = { execute, register: () => ({ dispose() {} }), list: () => [] } as unknown as ICommandBus;
    const id = await repository.createSession('Loaded title');
    const getUIState = vi.spyOn(repository, 'getUIState');
    const getLoadState = vi.spyOn(repository, 'getLoadState');
    const loadView = vi.spyOn(repository, 'loadView');
    const bind = vi.spyOn(sessions, 'bindSession');
    return { sessions, repository, agents, id, getUIState, getLoadState, loadView, bind, commandBus, execute, fs, kernel };
}

it.each(['main', 'review'])('initializes %s once and restores the selected branch draft and settings', async branch => {
    const f = await fixture();
    await f.repository.writeDocument(f.id, 'round-r0.json', JSON.stringify({ id: 'r0', sessionId: f.id, kind: 'chat', status: 'completed', createdAt: 1,
        historyParentIds: [], input: [{ role: 'user', content: 'Stored question' }], output: [{ role: 'assistant', content: 'Stored answer' }] }));
    await f.repository.updateManifest(f.id, { rootRoundId: 'r0', currentHead: 'r0', branches: { main: 'r0', review: null } });
    await f.repository.updateUIState(f.id, { branchDrafts: { main: { inputText: 'main draft' }, review: { inputText: 'review draft' } }, historyVisibility: 'hidden', collapseStates: { 'round-r0-user': false } });
    await f.repository.saveSessionSettings(f.id, { executionMode: 'agent' });
    const settingsWrite = vi.spyOn(f.repository, 'saveSessionSettings');
    const uiWrite = vi.spyOn(f.repository, 'updateUIState');
    const onLoadMetrics = vi.fn();
    const container = document.createElement('div'); document.body.append(container);
    const editor = new LLMWorkspaceEditor(container, { sessionManager: f.sessions, sessionId: f.id, target: { kind: 'session', sessionId: f.id, branch },
        sessionRepository: f.repository, commandBus: f.commandBus, agentService: f.agents as never, onLoadMetrics });
    cleanup.push(() => editor.destroy());
    await editor.init(container);
    expect(settingsWrite).not.toHaveBeenCalled();
    expect(uiWrite).not.toHaveBeenCalled();
    expect(onLoadMetrics).toHaveBeenCalledWith({ sessionId: f.id, durationMs: expect.any(Number), stages: {
        layout: expect.any(Number), bindSession: expect.any(Number), componentsAndSettings: expect.any(Number),
        restoreAndRender: expect.any(Number), branches: expect.any(Number),
    } });
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.agents.getConnections).toHaveBeenCalledTimes(1);
    const user = container.querySelector('[data-session-id="round-r0-user"]');
    if (branch === 'main') { expect(user).not.toBeNull(); expect(user?.classList.contains('is-collapsed')).toBe(false); }
    else expect(user).toBeNull();
    expect(f.getUIState).not.toHaveBeenCalled();
    // Switching a branch mutates the manifest, so the projection is read again after the bind.
    expect(f.getLoadState).toHaveBeenCalledTimes(1);
    // A branch switch may re-read the chain while reconciling the projection.
    expect(f.loadView).toHaveBeenCalled();
    expect(f.execute.mock.calls.filter(([name]) => name === 'vcs.branch.list')).toHaveLength(0);
    expect(container.querySelector('.llm-branch-indicator-name')?.textContent).toBe(branch);
    expect(f.execute.mock.calls.filter(([name]) => name === SessionCommand.GetSettings)).toHaveLength(0);
    expect(container.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe(`${branch} draft`);
    expect(container.querySelector<HTMLInputElement>('#llm-title-input')?.value).toBe('Loaded title');
    expect(container.querySelector('[data-execution-mode="agent"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((await f.repository.getManifest(f.id)).currentBranch).toBe(branch);
    // Explicit reload must fetch fresh state rather than keep initialization data forever.
    await f.repository.updateUIState(f.id, { branchDrafts: { [branch]: { inputText: 'changed externally' } } });
    await editor.setTextAsync('');
    expect(f.bind).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('changed externally');
});

it('measures A → B → A with retained session state and fresh editor preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-switch-cost-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const fsOps = new NodeFsOps();
    const fileCalls = { readFile: vi.spyOn(fsOps, 'readFile'), writeFile: vi.spyOn(fsOps, 'writeFile'),
        readDir: vi.spyOn(fsOps, 'readDir'), stat: vi.spyOn(fsOps, 'stat'), statMany: vi.spyOn(fsOps, 'statMany') };
    const fileCounts = () => Object.fromEntries(Object.entries(fileCalls).map(([name, spy]) => [name, spy.mock.calls.length]));
    const backend = await openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'db'), createFs: () => fsOps });
    const f = await fixture(backend);
    const second = await f.repository.createSession('Session B');
    for (const id of [f.id, second]) {
        for (let index = 0; index < 100; index++) await f.repository.writeDocument(id, `round-r${index}.json`, JSON.stringify({
            id: `r${index}`, sessionId: id, kind: 'chat', status: 'completed', createdAt: index,
            historyParentIds: index ? [`r${index - 1}`] : [],
            input: [{ role: 'user', content: `${id} question ${index}` }], output: [{ role: 'assistant', content: `answer ${index}` }],
        }));
        await f.repository.updateManifest(id, { rootRoundId: 'r0', currentHead: 'r99', branches: { main: 'r99' } });
    }
    const history = vi.spyOn(f.repository, 'readHistoryChain');
    const loadView = vi.spyOn(f.repository, 'loadView');
    const manifest = vi.spyOn(f.repository, 'getManifest');
    const children = vi.spyOn(f.fs.driver, 'getChildren');
    const samples: unknown[] = [];
    for (const [index, id] of [f.id, second, f.id].entries()) {
        if (index === 2) {
            await f.repository.updateManifest(id, { title: 'Updated A', uiState: { branchDrafts: { main: { inputText: 'Fresh draft' } } } });
            await f.repository.saveSessionSettings(id, { executionMode: 'agent' });
        }
        await f.kernel.waitIdle();
        history.mockClear(); loadView.mockClear(); manifest.mockClear(); children.mockClear(); backend.resetSidecarStats();
        Object.values(fileCalls).forEach(spy => spy.mockClear());
        const container = document.createElement('div'); document.body.append(container);
        let metrics: unknown;
        const editor = new LLMWorkspaceEditor(container, { sessionManager: f.sessions, sessionId: id, sessionRepository: f.repository,
            commandBus: f.commandBus, agentService: f.agents as never, onLoadMetrics: value => { metrics = value; } });
        try {
            await editor.init(container);
            const readySidecar = { ...backend.sidecarStats };
            const readyFiles = fileCounts();
            await f.kernel.waitIdle();
            samples.push({ label: ['A first', 'B first', 'A return'][index], metrics, readySidecar, readyFiles,
                idleSidecar: { ...backend.sidecarStats }, idleFiles: fileCounts(),
                historyReads: history.mock.calls.length, loadViews: loadView.mock.calls.length, manifestReads: manifest.mock.calls.length, directoryLists: children.mock.calls.map(([path]) => path) });
            expect(container.querySelector('[data-session-id="round-r99-user"]')?.textContent).toContain(`${id} question 99`);
            // The chain is read together with the projection, and a registered Session is not
            // re-read when it is revisited.
            expect(history).toHaveBeenCalledTimes(0);
            expect(loadView).toHaveBeenCalledTimes(index === 2 ? 0 : 1);
            // The bind hands its manifest to the projection sync, so a first load does not read
            // the Session record again; a revisit re-reads it because the registry drops the
            // projection when it does not re-read the chain.
            expect(manifest).toHaveBeenCalledTimes(index === 2 ? 1 : 0);
            if (index === 2) {
                expect(container.querySelector<HTMLInputElement>('#llm-title-input')?.value).toBe('Updated A');
                expect(container.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('Fresh draft');
                expect(container.querySelector('[data-execution-mode="agent"]')?.getAttribute('aria-pressed')).toBe('true');
            }
        } finally { await editor.destroy(); container.remove(); }
    }
    console.info('session-switch-localfs', JSON.stringify(samples));
}, 30_000);

it('restores the persisted branch draft when navigation does not specify a branch', async () => {
    const f = await fixture();
    await f.repository.updateManifest(f.id, { currentBranch: 'review', branches: { main: null, review: null } });
    await f.repository.updateUIState(f.id, { branchDrafts: {
        main: { inputText: 'main draft' }, review: { inputText: 'selected draft' },
    } });
    const container = document.createElement('div'); document.body.append(container);
    const editor = new LLMWorkspaceEditor(container, { sessionManager: f.sessions, sessionId: f.id, sessionRepository: f.repository,
        commandBus: f.commandBus, agentService: f.agents as never });
    cleanup.push(() => editor.destroy());
    await editor.init(container);
    expect(container.querySelector<HTMLTextAreaElement>('.llm-input__textarea')?.value).toBe('selected draft');
    expect(f.getUIState).not.toHaveBeenCalled();
    // Bind returns the projection, so the editor does not read the Session record again.
    expect(f.getLoadState).toHaveBeenCalledTimes(0);
    expect(f.loadView).toHaveBeenCalledTimes(1);
});

it('profiles complete editor initialization with LocalFS history and preserves stored UI/settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'editor-load-cost-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const backend = await openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'db') });
    const f = await fixture(backend);
    for (let index = 0; index < 100; index++) await f.repository.writeDocument(f.id, `round-r${index}.json`, JSON.stringify({
        id: `r${index}`, sessionId: f.id, kind: 'chat', status: 'completed', createdAt: index,
        historyParentIds: index ? [`r${index - 1}`] : [],
        input: [{ role: 'user', content: `question ${index}` }], output: [{ role: 'assistant', content: `answer ${index}` }],
    }));
    await f.repository.updateManifest(f.id, { rootRoundId: 'r0', currentHead: 'r99', branches: { main: 'r99' } });
    const before = await f.repository.getManifest(f.id), settings = await f.repository.getSessionSettings(f.id);
    const container = document.createElement('div'); document.body.append(container);
    const editor = new LLMWorkspaceEditor(container, { sessionManager: f.sessions, sessionId: f.id, sessionRepository: f.repository,
        commandBus: f.commandBus, agentService: f.agents as never,
        onLoadMetrics: metrics => console.info('editor-load-localfs', JSON.stringify({ ...metrics, sidecar: backend.sidecarStats })),
    });
    cleanup.push(() => editor.destroy());
    backend.resetSidecarStats();
    await editor.init(container);
    expect(container.querySelector('[data-session-id="round-r99-user"]')).not.toBeNull();
    expect(await f.repository.getManifest(f.id)).toEqual(before);
    expect(await f.repository.getSessionSettings(f.id)).toEqual(settings);
});


it('persists Agent and Connection changes to the original Session before disposal or debounce', async () => {
    const f = await fixture();
    vi.spyOn(f.agents, 'findAgent').mockReturnValue({ id: 'chosen', name: 'Chosen' } as never);
    const container = document.createElement('div'); document.body.append(container);
    const editor = new LLMWorkspaceEditor(container, { sessionManager: f.sessions, sessionId: f.id, sessionRepository: f.repository,
        commandBus: f.commandBus, agentService: f.agents as never });
    cleanup.push(() => editor.destroy()); await editor.init(container);
    const input = (editor as unknown as { chatInput: {
        setConfig: (config: unknown) => void; selectAgent: (id: string) => void;
    } }).chatInput;
    input.setConfig({ settings: { connectionId: 'chosen-connection', modelTier: 'fast' } });
    input.selectAgent('chosen');
    const otherId = await f.repository.createSession('Other');
    await f.execute(SessionCommand.Bind, { sessionId: otherId });
    await editor.flushPendingSave();
    const fresh = new SessionRepository(f.fs);
    expect((await fresh.getSessionSettings(f.id))).toMatchObject({ connectionId: 'chosen-connection', modelTier: 'fast' });
    expect((await fresh.getUIState(f.id))?.branchDrafts?.main?.inputAgentId).toBe('chosen');
    expect((await fresh.getSessionSettings(otherId)).connectionId).not.toBe('chosen-connection');
});

it('releases layout and shared connection subscriptions after factory initialization fails', async () => {
    const f = await fixture(), container = document.createElement('div');
    const unsubscribe = vi.fn(); f.agents.onChange = () => unsubscribe;
    const removeListener = vi.spyOn(container, 'removeEventListener');
    const failure = new Error('Bind failed'); f.bind.mockRejectedValueOnce(failure);
    const factory = createLLMFactory(f.agents as never, { sessionManager: f.sessions,
        sessionRepository: f.repository, commandBus: f.commandBus });
    await expect(factory(container, { target: { kind: 'session', sessionId: f.id } })).rejects.toBe(failure);
    expect(container.innerHTML).toBe('');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('click', expect.any(Function));
});

it('continues disposal after save failure and returns the same destruction promise', async () => {
    const f = await fixture(), container = document.createElement('div');
    const editor = new LLMWorkspaceEditor(container, { sessionManager: f.sessions, sessionId: f.id,
        sessionRepository: f.repository, commandBus: f.commandBus, agentService: f.agents as never });
    await editor.init(container);
    const failure = new Error('Save failed');
    vi.spyOn(editor, 'flushPendingSave').mockRejectedValue(failure);
    const destroy = editor.destroy(); expect(editor.destroy()).toBe(destroy);
    await expect(destroy).rejects.toMatchObject({ errors: [failure] });
    expect(container.innerHTML).toBe('');
});
