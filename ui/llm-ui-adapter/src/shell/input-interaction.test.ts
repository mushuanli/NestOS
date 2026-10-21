import { describe, expect, it } from 'vitest';
import { inputInteraction } from './input-interaction';
import { agentQuestionAnswer } from '../components/input/agent-questions';
import type { JsonValue } from '@itookit/durable-kernel/contracts';

const question = { question: 'Choose a destination?', header: 'Destination', options: [
    { label: 'Local', description: 'Keep data here' }, { label: 'Remote', description: 'Send to another host' },
] };
const view = (questions: JsonValue, kind: 'input' | 'approval' = 'input') => inputInteraction({
    id: 'ask', kind, prompt: question.question, payload: { questions, options: null },
}, 3);

describe('durable question presentation', () => {
    it('projects nested choices and descriptions without displaying raw question JSON', () => {
        const request = view([question]);
        expect(request.key).toBe('3:ask'); expect(request.details).toBeUndefined();
        expect(request.fields).toMatchObject([{ id: 'question-0', kind: 'single-choice', required: true,
            label: question.question, choices: question.options.map(option => ({ id: option.label, ...option })) }]);
    });
    it('preserves multiple questions, multi-selection and free-text fields', () => {
        const request = view([question, { ...question, question: 'Choose features?', multiSelect: true }, { question: 'Explain?' }]);
        expect(request.fields?.map(field => field.kind)).toEqual(['single-choice', 'multi-choice', 'text']);
        expect(request.fields?.map(field => field.id)).toEqual(['question-0', 'question-1', 'question-2']);
    });
    it.each([null, [], [{ options: question.options }], [question, { question: '' }],
        [{ question: 'Invalid', options: [{ description: 'missing label' }] }]])('keeps malformed questions readable: %j', questions => {
        const request = view(questions);
        expect(request.fields).toBeUndefined();
        expect(request.details).toBe(questions == null ? undefined : JSON.stringify(questions, null, 2));
    });
    it('keeps approval payloads and top-level option strings compatible', () => {
        expect(view([question], 'approval').fields).toBeUndefined();
        const request = inputInteraction({ id: 'ask', kind: 'input', prompt: 'Continue?', payload: { options: ['Yes', 'No'] } }, 1);
        expect(request.options).toEqual(['Yes', 'No']); expect(request.fields).toBeUndefined();
    });
    it('serializes exact single and multiple selections using the existing string response contract', () => {
        const fields = view([question, { ...question, question: 'Features?', multiSelect: true }]).fields!;
        const answer = agentQuestionAnswer(fields, { kind: 'input', values: { 'question-0': 'Local', 'question-1': ['a,b', 'c'] } });
        expect(JSON.parse(answer)).toEqual({ answers: { [question.question]: 'Local', 'Features?': '["a,b","c"]' } });
        expect(answer).not.toContain('[object Object]');
    });
    it('retains answers for repeated question texts without merging controls or overwriting values', () => {
        const fields = view([question, question]).fields!;
        const answer = agentQuestionAnswer(fields, { kind: 'input', values: { 'question-0': 'Local', 'question-1': 'Remote' } });
        expect(JSON.parse(answer).answers).toEqual({ '1. Choose a destination?': 'Local', '2. Choose a destination?': 'Remote' });
    });
});
