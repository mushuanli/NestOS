import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@itookit/mindos-node-driver';
import { nativeInputResponse } from '../src/projects/harness-execution-input';

const questions = [
    { id: 'destination', question: 'Choose destination', options: [{ label: 'Local' }] },
    { id: 'features', question: 'Choose features', multiSelect: true, options: [{ label: 'Read' }, { label: 'Write' }] },
];
function request(items = questions): HarnessEvent['message'] {
    return { id: 'request', method: 'item/tool/requestUserInput', params: { questions: items } };
}

describe('platform human input to native question response', () => {
    it('maps the actual InteractionPanel JSON string contract, including serialized multiple choices', () => {
        const response = JSON.stringify({ answers: { 'Choose destination': 'Local', 'Choose features': '["Read","Write"]' } });
        expect(nativeInputResponse(request(), response)).toEqual({ answers: {
            destination: { answers: ['Local'] }, features: { answers: ['Read', 'Write'] },
        } });
    });
    it('maps duplicate labels with the platform one-based prefix to independent native question ids', () => {
        const items = questions.map(question => ({ ...question, question: 'Choose' }));
        expect(nativeInputResponse(request(items), JSON.stringify({ answers: { '1. Choose': 'Local', '2. Choose': '["Read","Write"]' } })))
            .toEqual({ answers: { destination: { answers: ['Local'] }, features: { answers: ['Read', 'Write'] } } });
    });
    it('preserves plain text only for an unambiguous single question', () => {
        expect(nativeInputResponse(request([questions[0]]), 'A custom destination'))
            .toEqual({ answers: { destination: { answers: ['A custom destination'] } } });
        expect(() => nativeInputResponse(request(), 'ambiguous')).toThrow('NATIVE_INPUT_INVALID');
    });
    it('passes valid native structured input through unchanged', () => {
        const answer = { answers: { destination: { answers: ['Local'] }, features: { answers: ['Read', 'Write'] } } };
        expect(nativeInputResponse(request(), answer)).toBe(answer);
    });
    it.each([true, false])('rejects approval boolean %j as a native input answer', answer => {
        expect(() => nativeInputResponse(request([questions[0]]), answer)).toThrow('NATIVE_INPUT_INVALID');
    });
    it.each([
        '{"answers":{"Choose destination":"Local"}}',
        '{"answers":{"Choose destination":"Local","unknown":"Read"}}',
        '{"answers":{"Choose destination":"","Choose features":"Read"}}',
    ])('refuses incomplete or unknown platform answer keys %s', answer => {
        expect(() => nativeInputResponse(request(), answer)).toThrow('NATIVE_INPUT_INVALID');
    });
    it('rejects multiple answers to a single-choice question and invalid native ids', () => {
        expect(() => nativeInputResponse(request([questions[0]]), { answers: { destination: { answers: ['Local', 'Other'] } } }))
            .toThrow('NATIVE_INPUT_INVALID');
        expect(() => nativeInputResponse(request([questions[0]]), { answers: { wrong: { answers: ['Local'] } } }))
            .toThrow('NATIVE_INPUT_INVALID');
    });
});
