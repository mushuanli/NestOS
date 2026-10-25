import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {ArtifactCommand, type ExecutionArtifactPage, type ExecutionArtifactChunk} from '@itookit/app-contracts';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

it('wires artifact commands and the Session context reader to committed outputs without activation', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'tauri', digitalTwinAutoStart: false});
    try {
        const sessionId = await runtime.sessionRepository.createSession('Artifact owner');
        await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
        runtime.kernel.kernel.programs.register({manifest: {kind: 'artifact-fixture', version: '1'},
            init: input => ({state: null, next: {type: 'complete', output: input}}),
            reduce: () => ({state: null, next: {type: 'complete', output: null}})});
        const session = await runtime.kernel.kernel.openSession(sessionId);
        const task = await session.submit({program: {kind: 'artifact-fixture', version: '1'}, input: {outputs: {
            report: {outputName: 'report', type: 'text', content: 'committed report'},
        }}});
        await task.wait({timeoutMs: 4000});
        const before = await runtime.kernel.kernel.task(sessionId, task.id), open = vi.spyOn(runtime.kernel.kernel, 'openSession');
        const page = await runtime.commandBus.execute<ExecutionArtifactPage>(ArtifactCommand.List, {sessionId, taskId: task.id});
        expect(page.items[0]).toMatchObject({kind: 'text', bytes: 16});
        const chunk = await runtime.commandBus.execute<ExecutionArtifactChunk>(ArtifactCommand.Read, {reference: page.items[0].reference});
        expect(new TextDecoder().decode(chunk.data)).toBe('committed report');
        expect(await runtime.commandBus.execute(SessionCommand.ArtifactGet, {artifactId: page.items[0].reference.artifactId}))
            .toMatchObject({content: 'committed report', nodeRunId: task.id});
        expect(open).not.toHaveBeenCalled(); expect(await runtime.kernel.kernel.task(sessionId, task.id)).toEqual(before);
        open.mockRestore();
        const other = await runtime.sessionRepository.createSession('Another owner');
        await runtime.commandBus.execute(SessionCommand.Bind, {sessionId: other});
        await expect(runtime.commandBus.execute(SessionCommand.ArtifactGet, {artifactId: page.items[0].reference.artifactId})).rejects.toThrow();
    } finally {await runtime.dispose();}
}, 15000);
