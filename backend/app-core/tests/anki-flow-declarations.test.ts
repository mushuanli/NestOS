import {afterEach, expect, it} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {FlowCommand, flowConnectionRequired, flowParameterValues, type FlowDraft, type FlowRevision, type JsonValue} from '@itookit/llm-flow/contracts';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {createNestosFlowLibrary} from '../src/presets/flow-library';

let runtime: Awaited<ReturnType<typeof createApplicationRuntime>> | undefined;
afterEach(async () => {await runtime?.dispose(); runtime = undefined;});
const image = [{type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}}];

it('publishes declared composer sources and connection requirements without replacing a user draft or revision', async () => {
    runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    const revision = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, {id: 'anki-generate'});
    expect(revision.parameters?.find(field => field.name === 'words')?.inputSource).toBe('composer.text');
    expect(revision.parameters?.find(field => field.name === 'images')?.inputSource).toBe('composer.attachments');
    expect(revision.inputGroups).toEqual([{name: 'content', label: '输入方式', mode: 'anyOf', parameters: ['words', 'images', 'wordsGroups']}]);
    expect(revision.connections?.map(slot => slot.label)).toEqual(['文本生成连接', '文生图连接', 'tts语音连接', 'OCR图片识别连接']);
    for (const [flowId, nodeId] of [['anki-recognize-group', 'recognize'], ['anki-complete-batch', 'generate']]) {
        const node = revision.functions?.find(flow => flow.id === flowId)?.nodes.find(node => node.id === nodeId);
        expect(node?.config).toMatchObject({responseFormat: {type: 'text'}, outputValidation: {onInvalid: 'repair', retries: 2,
            schema: {type: 'object', required: ['cards']}}});
    }
    const generation = revision.functions?.find(flow => flow.id === 'anki-complete-batch')?.nodes.find(node => node.id === 'generate')?.config as any;
    const schema = generation.outputValidation.schema;
    for (const field of schema.properties.cards.items.required.filter((name: string) => name !== 'unit'))
        expect(schema.properties.cards.items.properties[field]).toMatchObject({type: 'string', minLength: 1, pattern: String.fromCharCode(92) + 'S'});
    const prefix = '输出 JSON 必须满足以下结构，字段名和类型必须严格一致：';
    expect(JSON.parse(generation.systemPrompt.find((text: string) => text.startsWith(prefix)).slice(prefix.length))).toEqual(schema);
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'anki-generate'});
    await runtime.commandBus.execute(FlowCommand.DraftSave, {draft: {...draft, name: 'Personal flow'}, expectedDraftVersion: draft.draftVersion});
    expect(await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: createNestosFlowLibrary()})).toBe(0);
    expect((await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'anki-generate'})).name).toBe('Personal flow');
    expect(await runtime.commandBus.execute(FlowCommand.RevisionGet, {id: 'anki-generate'})).toEqual(revision);
});

it('requires only the connections used by the selected input and enabled output options during preflight', async () => {
    runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    await runtime.agentService.saveProvider({id: 'fixture', name: 'Fixture', baseURL: 'https://example.test', apiKey: 'fixture-key', implementation: 'openai-compatible',
        models: [{id: 'text-model', name: 'Text'}, {id: 'vision-model', name: 'Vision', supportsVision: true}]});
    for (const [id, model] of [['text', 'text-model'], ['vision', 'vision-model']]) await runtime.agentService.saveConnection({id, name: id, providerId: 'fixture', protocol: 'openai-chat', tiers: {optimal: model, standard: model}});
    const flow = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, {id: 'anki-generate'});
    const check = (parameters: Record<string, JsonValue>, connectionBindings: Record<string, string> = {text: 'text'}) => runtime!.commandBus.execute(SessionCommand.CheckFlowConnections, {flow, parameters, connectionBindings});
    await expect(check({words: 'apple'})).resolves.toEqual({valid: true});
    await expect(check({words: 'apple', generateImages: true})).rejects.toThrow('image');
    await expect(check({words: 'apple', generateAudio: true})).rejects.toThrow('speech');
    await expect(check({images: image})).rejects.toThrow('vision');
    await expect(check({images: image}, {text: 'text', vision: 'text'})).rejects.toThrow('input capability');
    await expect(check({words: 'apple', images: image}, {text: 'text', vision: 'vision'})).resolves.toEqual({valid: true});
    const installation = await runtime.flowInstallations.check('anki-generate');
    expect(installation.connections.every(issue => !issue.message.includes('input node'))).toBe(true);
    const values = flowParameterValues(flow.parameters, {words: 'apple', images: image, generateImages: true, generateAudio: true});
    expect(flow.connections?.filter(slot => flowConnectionRequired(slot, values)).map(slot => slot.name)).toEqual(['text', 'image', 'speech', 'vision']);
});
