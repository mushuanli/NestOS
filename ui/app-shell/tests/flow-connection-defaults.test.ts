import {expect, it} from 'vitest';
import {flowConnectionSelection} from '../../llm-ui-adapter/src/flows/connection-selection';

it('prefills conditional media slots without treating the chat default as an OCR connection', async () => {
    const requiredWhen = {kind: 'param' as const, path: ['enabled']};
    const connections = ['chat', 'image', 'speech'].map(id => ({id, name: id, providerId: 'fixture', credentialsReady: true,
        enabled: true, operationModels: {[id === 'image' ? 'image.generate' : id === 'speech' ? 'speech.synthesize' : 'chat']: id}}));
    const commands = {execute: async () => ({connections, modelDefaults: {chat: 'chat', 'image.generate': 'image', 'speech.synthesize': 'speech'}})};
    const selection = await flowConnectionSelection(commands as never, undefined, [
        {name: 'pictures', required: false, requiredWhen, requirements: {operation: 'image.generate', inputModalities: ['text']}},
        {name: 'audio', required: false, requiredWhen, requirements: {operation: 'speech.synthesize', inputModalities: ['text']}},
        {name: 'recognition', required: false, requiredWhen, requirements: {operation: 'chat', inputModalities: ['text', 'image']}},
    ]);
    expect(selection.bindings).toEqual({pictures: 'image', audio: 'speech'});
});

it('preserves explicit bindings and leaves unavailable purpose defaults unselected', async () => {
    const commands = {execute: async () => ({connections: [
        {id: 'disabled', enabled: false, credentialsReady: true},
        {id: 'text-only', enabled: true, credentialsReady: true, operationModels: {chat: 'text'}},
    ], modelDefaults: {chat: 'disabled', 'image.generate': 'text-only'}})};
    const selection = await flowConnectionSelection(commands as never, undefined, [
        {name: 'text', requirements: {operation: 'chat'}},
        {name: 'image', requirements: {operation: 'image.generate'}},
        {name: 'explicit', requirements: {operation: 'chat'}},
    ], {explicit: 'chosen-by-user'});
    expect(selection.bindings).toEqual({explicit: 'chosen-by-user'});
});
