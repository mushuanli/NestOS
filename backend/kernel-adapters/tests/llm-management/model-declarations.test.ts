import {expect, it} from 'vitest';
import {completeModelDeclaration} from '@itookit/device-llm/contracts';
import {createLlmDeviceCatalog} from '@itookit/device-llm';
const volcengineImageModels = createLlmDeviceCatalog().providers.volcengine.models.filter(model => model.category === 'image');
import {requireMediaCapabilities} from '@itookit/driver-llm/contracts';

it('repairs exact documented image IDs while retaining user-specific configuration', () => {
    const preset = volcengineImageModels.find(model => model.id === 'doubao-seedream-5-0-flash-260915')!;
    const model = completeModelDeclaration({id: preset.id, name: 'My image model', category: 'chat', capabilitiesKnown: false}, preset);
    expect(model).toMatchObject({name: 'My image model', category: 'image', capabilitiesKnown: true, supportedOperations: ['image.generate']});
    expect(requireMediaCapabilities({media: {'image.generate': {adapter: 'volcengine-images'}}} as never, model, 'image.generate').formats).toEqual(['png', 'jpeg']);
    const custom = {...preset, operations: {'image.generate': {...preset.operations!['image.generate']!, formats: ['jpeg']}}};
    expect(completeModelDeclaration(custom, preset).operations).toEqual(custom.operations);
});

it('never borrows declarations from a similar model name or a different ID', () => {
    const model = {id: 'doubao-seedream-4-0-20260415', name: 'doubao-seedream-4-0', capabilitiesKnown: false};
    expect(completeModelDeclaration(model, volcengineImageModels[0])).toBe(model);
});
