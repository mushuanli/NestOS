import {expect, it} from 'vitest';
import {assertModelOutputFormats, modelOutputFormats} from '../../src/llm-management/contracts/model-output-formats';

it('intersects selected protocols with an affirmative structured-output model declaration', () => {
    const model = {id: 'fixture', supportsStructuredOutput: true};
    expect(modelOutputFormats(model, 'anthropic-messages')).toEqual(['text', 'json_schema']);
    expect(modelOutputFormats(model, 'openai-chat')).toEqual(['text', 'json_object', 'json_schema']);
    expect(() => assertModelOutputFormats(model, 'anthropic-messages', ['json_object'])).toThrow(/anthropic-messages.*json_object/);
    expect(() => assertModelOutputFormats(model, 'anthropic-messages', ['json_schema'])).not.toThrow();
});

it.each([false, undefined])('keeps unknown or negative model output declarations conservative (%s)', supportsStructuredOutput => {
    const model = {id: 'fixture', supportsStructuredOutput};
    expect(modelOutputFormats(model, 'openai-chat')).toEqual(['text']);
    expect(() => assertModelOutputFormats(model, 'openai-chat', ['json_schema'])).toThrow('unsupported or unknown');
    expect(() => assertModelOutputFormats(model, 'anthropic-messages', ['text'])).not.toThrow();
});

it('does not infer an output format from a model name or an unknown protocol', () => {
    expect(modelOutputFormats({id: 'schema-json-vision', supportsStructuredOutput: true}, undefined)).toEqual([]);
    expect(modelOutputFormats({id: 'schema-json-vision'}, 'openai-chat')).toEqual(['text']);
});
