import { afterEach, expect, it } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { FlowCommand, type FlowDraft, type FlowRevision } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { bindLocalApplicationServices } from '../src/host/application-services';
import { createApplicationClient } from '../src/host/application-client';
import { externalFlow, standaloneFlow } from './fixtures/flow-library';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    const toolbox = await client.backend.toolboxView();
    return { runtime, resources: toolbox.resources };
}

it('restores and publishes one standalone definition without installing its inline functions separately', async () => {
    const { runtime } = await setup(), template = standaloneFlow();
    expect(await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [template] })).toBe(1);
    const loaded = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: template.id });
    expect(loaded.functions).toEqual(template.functions);
    const revision = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: template.id });
    expect(revision.functions?.map(flow => flow.id)).toEqual(['helper']);
    expect(revision.functions?.[0].functions?.map(flow => flow.id)).toEqual(['inner']);
    expect(revision.dependencyLocks?.invoke).toMatchObject({ flowId: 'helper', digest: expect.any(String) });
    const drafts = await runtime.commandBus.execute<FlowDraft[]>(FlowCommand.DraftList, {});
    expect(drafts.map(flow => flow.id).sort()).toEqual(['anki-generate', 'essay-review', 'standalone']);
    expect(await runtime.commandBus.execute(FlowCommand.RevisionGet, { id: 'helper' })).toBeNull();
    expect(await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [template] })).toBe(0);
});

it('round trips nested functions and their prompt dependencies without remapping local function identities', async () => {
    const { runtime, resources } = await setup(), template = standaloneFlow();
    for (const flow of [template.functions![0], template.functions![0].functions![0]]) flow.defaults = { systemPromptId: 'inline-rules' };
    await runtime.agentService.saveSystemPrompt({ id: 'inline-rules', name: 'Inline rules', content: ['Keep the supplied arguments.'] });
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [template, externalFlow('helper')] });
    const archive = await resources.export(['/flows/standalone.flow', '/flows/helper.flow']);
    expect(JSON.parse(archive).entries.map((entry: { kind: string }) => entry.kind)).toEqual(['flows', 'flows', 'prompts']);
    const imported = await resources.import(archive);
    const promptId = imported.find(path => path.startsWith('/prompts/'))!.slice('/prompts/'.length);
    const flowPaths = imported.filter(path => path.startsWith('/flows/'));
    const mainId = flowPaths[0].slice('/flows/'.length).replace(/\.flow$/, '');
    const globalId = flowPaths[1].slice('/flows/'.length).replace(/\.flow$/, '');
    const main = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: mainId });
    expect(mainId).not.toBe('standalone'); expect(globalId).not.toBe('helper');
    expect(main.nodes[0].config).toMatchObject({ flowId: 'helper' });
    expect(main.functions![0]).toMatchObject({ id: 'helper', defaults: { systemPromptId: promptId } });
    expect(main.functions![0].functions![0]).toMatchObject({ id: 'inner', defaults: { systemPromptId: promptId } });
    await runtime.commandBus.execute(FlowCommand.RevisionCreate, { draftId: main.id, expectedDraftVersion: main.draftVersion });
    const published = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: main.id });
    expect(published.dependencyLocks?.invoke).toMatchObject({ flowId: 'helper', children: { invoke: { flowId: 'inner' } } });
});
