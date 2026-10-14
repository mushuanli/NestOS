import { parseLoadedSkillIds } from '@itookit/kernel-adapters';
/**
 * P0-00 应用宿主半边：按**桌面宿主（Tauri）的装配方式**（`createApplicationRuntime` +
 * `TauriSkillSource`）发起一次真实聊天运行，核对落盘的运行输入里同时出现项目规则与
 * Skill 正文/关键规则，并核对持久加载身份——与 `apps/cli/tests/run-skill-context.test.ts`
 * 的 CLI 半边对应。运行输入在模型调用前提交，所以这里不需要可用的模型服务。
 *
 * 覆盖宿主装配与共享解析器；真实窗口/IPC 验收仍属 P0-04。
 */
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryBackend } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { FakeSidecarDb } from './fake-sidecar';
import { createApplicationRuntime } from '@itookit/app-core';
import { SessionCommand } from '@itookit/llm-session';
import { createAgentSendIntent } from '@itookit/llm-flow/contracts';
import { createSessionSkillControls, resolveSessionSkillContext } from '@itookit/kernel-adapters';
import { TauriSkillSource } from '../../../apps/tauri-app/src/kernel/tauri-skill-source';

const SKILL = [
    '---', 'name: Review', 'description: Review changes', '---',
    'Check every changed interface.',
    '', '## Compact Instructions', '- [红线] Preserve access checks.', '- Background note.',
].join('\n');

/** Exactly the wiring apps/tauri-app/src/main.ts passes. */
const platform = () => ({ skillSourceForSession: (files: { vfs: never; cwd: string }) => new TauriSkillSource(files.vfs, files.cwd) });

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;

/** The host mounts a project directory as the Session workspace; `_agent/` lives there. */
async function mountProject(runtime: Runtime, sessionId: string) {
    const home = await runtime.vfs.openFileSystem('/home/admin');
    await home.driver.createFile({ name: 'AGENT.md', parentPath: '/project/_agent', recursive: true, content: 'Always cite the interface contract.' });
    await home.driver.createFile({ name: 'SKILL.md', parentPath: '/project/_agent/skills/review', recursive: true, content: SKILL });
    runtime.sessionFiles.registerSource('project', home);
    await runtime.sessionFiles.configure(sessionId, {
        mounts: [{ mountId: 'project', sourceId: 'project', at: '/workspace', root: '/project', access: 'rw' }],
        cwd: '/workspace',
    }, 0);
}

/** Returns the error a run raised (the model service is unavailable in tests), if any. */
async function dispatch(runtime: Runtime, sessionId: string, text: string): Promise<unknown> {
    await runtime.agentService.setDefaultConnection('default');
    // The assembled input is committed before the model call, so a failing model is expected.
    return runtime.commandBus.execute(SessionCommand.Send, {
        text, files: [], agentId: 'default', sendIntent: createAgentSendIntent('default'),
    }).then(() => undefined, error => error);
}

async function send(runtime: Runtime, sessionId: string, text: string): Promise<unknown> {
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId });
    return dispatch(runtime, sessionId, text);
}

it('assembles project rules and auto-loaded Skills into an app-host chat run', async () => {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'tauri', kernelPlatform: platform() });
    try {
        const sessionId = await runtime.sessionRepository.createSession('Session');
        await mountProject(runtime, sessionId);

        await send(runtime, sessionId, 'Please review the interface change');

        const kernel = runtime.kernel.kernel;
        await vi.waitFor(async () => expect(await kernel.listSessionTasks(sessionId)).toHaveLength(1), { timeout: 10_000 });
        const body = JSON.stringify(await kernel.listSessionTasks(sessionId));
        expect(body).toContain('Please review the interface change');
        expect(body).toContain('Always cite the interface contract.');
        expect(body).toContain('Check every changed interface.');
        // Only `[红线]` entries become protected critical rules in this context path.
        expect(body).toContain('Preserve access checks.');
        expect(body).not.toContain('Background note.');

        // The loaded identity is durable Session state that a reopening host restores.
        const loaded = await kernel.getShared(sessionId, 'kernel-adapters.skills.loaded');
        expect(parseLoadedSkillIds(loaded?.value)).toEqual(['review']);

        // A later assembly whose message no longer matches the trigger still gets the Skill body,
        // because the persisted loaded identity is restored first. This calls the same shared
        // resolver both hosts wire (the runtime's Session capability registry + the Tauri Skill source).
        const again = await resolveSessionSkillContext(kernel, runtime.kernel.sessions, sessionId, 'Now explain the deployment pipeline');
        expect(again.projectInstructions).toContain('Always cite the interface contract.');
        expect(again.skillInstructions).toContain('Check every changed interface.');
        expect(again.skillInstructions).toContain('Preserve access checks.');
    } finally { await runtime.dispose(); }
}, 30_000);

it('restores the persisted Skill identity when a new host instance starts the next run', async () => {
    // A real storage root is required: the point is that a *new* host instance recovers what
    // the previous one wrote, which an explicitly disposed in-memory backend cannot show.
    const root = await mkdtemp(join(tmpdir(), 'mindos-app-host-'));
    // The sidecar is the durable index for the local files; one instance across both hosts
    // stands in for the on-disk SQLite file a real host reopens.
    const sidecar = new FakeSidecarDb();
    const openBackend = () => openLocalFSBackend({ rootDir: join(root, 'data'), sidecarDir: join(root, 'db'), createDb: async () => sidecar });
    let sessionId = '';
    const first = await createApplicationRuntime({ backend: await openBackend(), ownerKind: 'tauri', kernelPlatform: platform() });
    try {
        sessionId = await first.sessionRepository.createSession('Session');
        await mountProject(first, sessionId);
        await send(first, sessionId, 'Please review the interface change');
        await vi.waitFor(async () => expect(await first.kernel.kernel.listSessionTasks(sessionId)).toHaveLength(1), { timeout: 20_000 });
        expect(parseLoadedSkillIds((await first.kernel.kernel.getShared(sessionId, 'kernel-adapters.skills.loaded'))?.value)).toEqual(['review']);
        // Let the failed run reach a terminal state before this host goes away, so the next host
        // starts from a settled round instead of racing a half-finished one.
        await vi.waitFor(async () => {
            const [task] = await first.kernel.kernel.listSessionTasks(sessionId);
            expect(['succeeded', 'failed', 'cancelled']).toContain(task.status);
        }, { timeout: 20_000 });
        // A terminal Task is not enough: the failed round must also be durable (round document
        // status + branch head), otherwise a reopening host restores a transcript ending on the
        // user message and refuses the next send as a consecutive user message.
        await vi.waitFor(async () => {
            const manifest = await first.sessionRepository.getManifest(sessionId);
            const head = (manifest as { currentHead?: string }).currentHead;
            expect(head, 'branch head is not durable yet').toBeTruthy();
            const raw = await first.sessionRepository.readDocument(sessionId, `round-${head}.json`);
            expect(JSON.parse(String(raw)).status, 'failed round is not durable yet').toBe('failed');
        }, { timeout: 20_000 });
    } finally { await first.dispose(); }
    // A fresh host on the same storage root must recover the Session, the mount config and the
    // loaded Skill identity, and the next run may no longer match the trigger.
    const second = await createApplicationRuntime({ backend: await openBackend(), ownerKind: 'tauri', kernelPlatform: platform() });
    try {
        expect((await second.sessionRepository.list()).map(entry => entry.id)).toContain(sessionId);
        second.sessionFiles.registerSource('project', await second.vfs.openFileSystem('/home/admin'));
        // The restored transcript must already end with the failed assistant placeholder; otherwise
        // the next send is refused as a consecutive user message.
        await second.commandBus.execute(SessionCommand.Bind, { sessionId });
        await vi.waitFor(() => {
            const tail = second.sessionManager.getSnapshot().sessions.at(-1);
            expect(tail?.role, `restored tail: ${JSON.stringify(tail)}`).toBe('assistant');
        }, { timeout: 20_000 });
        // Send without binding again: a second bind restarts the projection load, and the
        // send guard would then read a partially restored transcript.
        const failure = await dispatch(second, sessionId, 'Now explain the deployment pipeline');
        await vi.waitFor(async () => {
            expect(await second.kernel.kernel.listSessionTasks(sessionId), `second run raised: ${String(failure)}`).toHaveLength(2);
        }, { timeout: 20_000 });
        const tasks = await second.kernel.kernel.listSessionTasks(sessionId);
        const next = tasks.find(task => JSON.stringify(task).includes('Now explain the deployment pipeline'))!;
        expect(next).toBeDefined();
        const body = JSON.stringify(next);
        expect(body).toContain('Now explain the deployment pipeline');
        expect(body).toContain('Always cite the interface contract.');
        expect(body).toContain('Check every changed interface.');
        expect(body).toContain('Preserve access checks.');
        expect(body).not.toContain('Background note.');
    } finally { await second.dispose(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

const MANUAL_SKILL = [
    '---', 'name: Review', 'description: Review changes interface', 'auto-load: false', '---',
    'Check every changed interface.',
    '', '## Compact Instructions', '- [红线] Preserve access checks.', '- Background note.',
].join('\n');

/**
 * P0-00 strict loop through the Tauri host assembly: a reference Skill with `auto-load: false`
 * proves that what reaches a later run is the persisted loaded identity, not autoLoad, and that
 * unload really removes it without permanently disabling the definition.
 */
it('distinguishes persisted identity restore from autoLoad and respects unload in the Tauri assembly', async () => {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'tauri', kernelPlatform: platform() });
    try {
        const sessionId = await runtime.sessionRepository.createSession('Session');
        const home = await runtime.vfs.openFileSystem('/home/admin');
        await home.driver.createFile({ name: 'AGENT.md', parentPath: '/project/_agent', recursive: true, content: 'Always cite the interface contract.' });
        await home.driver.createFile({ name: 'SKILL.md', parentPath: '/project/_agent/skills/review', recursive: true, content: MANUAL_SKILL });
        runtime.sessionFiles.registerSource('project', home);
        await runtime.sessionFiles.configure(sessionId, {
            mounts: [{ mountId: 'project', sourceId: 'project', at: '/workspace', root: '/project', access: 'rw' }],
            cwd: '/workspace',
        }, 0);

        const kernel = runtime.kernel.kernel;
        // Binding creates the durable Kernel session the Skill resolver opens.
        await runtime.commandBus.execute(SessionCommand.Bind, { sessionId });
        const controls = createSessionSkillControls(kernel, runtime.kernel.sessions);

        // Never loaded and no trigger match: only the project rules, no auto-injection.
        const baseline = await resolveSessionSkillContext(kernel, runtime.kernel.sessions, sessionId, 'plain hello only');
        expect(baseline.projectInstructions).toContain('Always cite the interface contract.');
        expect(baseline.skillInstructions).not.toContain('Check every changed interface.');

        // An explicit (non-auto) load records the durable identity. A non-matching run now gets
        // the Skill through that identity — the same effect a reopened host observes.
        await controls.load(sessionId, 'review');
        expect(parseLoadedSkillIds((await kernel.getShared(sessionId, 'kernel-adapters.skills.loaded'))?.value)).toEqual(['review']);
        const restored = await resolveSessionSkillContext(kernel, runtime.kernel.sessions, sessionId, 'plain hello only');
        expect(restored.skillInstructions).toContain('Check every changed interface.');
        expect(restored.skillInstructions).toContain('Preserve access checks.');

        // Unload clears the identity; a later non-matching run must not resurrect the Skill.
        await controls.unload(sessionId, 'review');
        expect(parseLoadedSkillIds((await kernel.getShared(sessionId, 'kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        const afterUnload = await resolveSessionSkillContext(kernel, runtime.kernel.sessions, sessionId, 'plain hello only');
        expect(afterUnload.skillInstructions).not.toContain('Check every changed interface.');

        // Matching again is still allowed to load it: unload is not a permanent disable.
        const rematched = await resolveSessionSkillContext(kernel, runtime.kernel.sessions, sessionId, 'review changes now');
        expect(rematched.skillInstructions).toContain('Check every changed interface.');
    } finally { await runtime.dispose(); }
}, 30_000);
