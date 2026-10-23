import {expect, it} from 'vitest';
import {createLlmDeviceCatalog, supportsLlmProvider} from '../src';
import {completeModelDeclaration, resolveModelReferencePrice} from '../src/contracts';

it('provides an independent support snapshot including every builtin provider and its pricing mode', () => {
    const first = createLlmDeviceCatalog(), second = createLlmDeviceCatalog();
    expect(Object.keys(first.providers).sort()).toEqual(Object.keys(first.pricing.reference_catalog!.providers).sort());
    for (const id of Object.keys(first.providers)) expect(supportsLlmProvider(id)).toBe(true);
    expect(supportsLlmProvider('__proto__')).toBe(false); expect(supportsLlmProvider('missing')).toBe(false);
    first.providers.deepseek.name = 'Edited'; first.pricing.reference_catalog!.providers.deepseek.models[0].rates[0].input = 999;
    first.providerReferences['doubao-speech'].voices[0].name = 'Edited';
    expect(second.providers.deepseek.name).not.toBe('Edited');
    expect(second.pricing.reference_catalog!.providers.deepseek.models[0].rates[0].input).not.toBe(999);
    expect(createLlmDeviceCatalog().providerReferences['doubao-speech'].voices[0].name).not.toBe('Edited');
});

it('keeps exact model identity, documented operations and native billing units together', () => {
    const {providers, pricing} = createLlmDeviceCatalog();
    const model = providers.volcengine.models.find(item => item.id === 'doubao-seedream-5-0-flash-260915')!;
    expect(model.operations?.['image.generate']?.formats).toContain('png');
    expect(resolveModelReferencePrice(pricing.reference_catalog, 'volcengine', model.id)).toMatchObject({currency: 'CNY', unit: 'image'});
    expect(resolveModelReferencePrice(pricing.reference_catalog, 'doubao-speech', 'seed-tts-2.0')).toMatchObject({currency: 'CNY', unit: 'ten-thousand-characters'});
    const unknown = {id: 'doubao-seedream-4-0-20260415', name: 'Seedream'};
    expect(completeModelDeclaration(unknown, model)).toBe(unknown);
    expect(resolveModelReferencePrice(pricing.reference_catalog, 'volcengine', unknown.id)).toBeUndefined();
});

it('exposes implemented speech constraints while retaining unsupported API features only as reference', () => {
    const {providers, providerReferences} = createLlmDeviceCatalog(), reference = providerReferences['doubao-speech'];
    expect(providers['doubao-speech'].models.map(model => model.id)).toEqual(['seed-tts-2.0']);
    expect(reference.models.some(model => model.support === 'unsupported')).toBe(true);
    const operation = providers['doubao-speech'].models[0].operations!['speech.synthesize']!;
    expect(operation.voices).toEqual(reference.voices.map(voice => voice.id));
    expect(operation.formats).toEqual(reference.formats.filter(format => format.support === 'implemented').map(format => format.id));
    expect(operation.speedRange).toEqual({min: 0.5, max: 2});
});
