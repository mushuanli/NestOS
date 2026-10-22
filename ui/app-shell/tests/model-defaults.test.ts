// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { defaultConnectionMenu } from '../src/toolbox/model-defaults';
import { flowConnectionSelection } from '../../llm-ui-adapter/src/flows/connection-selection';
import { flowParameterFields } from '../../llm-ui-adapter/src/components/FlowParameterForm';

function fixture() {
    const inventory = { modelDefaults: { 'speech.synthesize': 'speech' }, providers: new Map([['p', { enabled: true, configured: true }]]),
        connections: new Map([['speech', { providerId: 'p', enabled: true, credentialsReady: true, operationModels: { 'speech.synthesize': 'Voice' } }]]) };
    const resources = { setModelDefault: vi.fn(async () => {}) }, navigate = vi.fn(async () => {});
    return { inventory, resources, navigate };
}
it('offers only compatible defaults and clears the selected purpose independently', async () => {
    const f = fixture(), menu = defaultConnectionMenu('speech', f.inventory as never, f.resources as never);
    expect(menu).toHaveLength(1); expect(menu[0]).toMatchObject({ id: 'default-speech.synthesize' });
    await (menu[0] as { onClick: () => Promise<void> }).onClick();
    expect(f.resources.setModelDefault).toHaveBeenCalledWith('speech.synthesize', null);
});
it('prefills required Flow purposes without overriding explicit or optional slots and filters incompatible choices', async () => {
    const commands = { execute: vi.fn(async () => ({ connections: [
        { id: 'chat', name: 'Chat', model: 'text', providerId: 'p', operationModels: { chat: 'Text' } },
        { id: 'image', name: 'Image', model: 'image', providerId: 'p', operationModels: { 'image.generate': 'Image' } },
    ], modelDefaults: { chat: 'chat', 'image.generate': 'image' } })) };
    const slots = [{ name: 'pictures', requirements: { operation: 'image.generate' } }, { name: 'optional', required: false, requirements: { operation: 'image.generate' } }];
    const selection = await flowConnectionSelection(commands as never, undefined, slots);
    expect(selection.bindings).toEqual({ pictures: 'image' });
    const root = document.createElement('div'); root.innerHTML = flowParameterFields([], selection);
    const options = [...root.querySelectorAll<HTMLOptionElement>('[data-slot-connection="0"] option')].map(option => option.value);
    expect(options).toEqual(['', 'image']);
    expect((await flowConnectionSelection(commands as never, undefined, slots, { pictures: 'explicit', optional: '' })).bindings).toEqual({ pictures: 'explicit', optional: '' });
});
