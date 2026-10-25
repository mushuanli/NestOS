import {expect, it} from 'vitest';
import {submissionInstruction} from '../src/session/submission-input';
import type {SubmissionRequest} from '../src/contracts/submission';

const request = (): SubmissionRequest => ({target: {kind: 'flow', id: 'worker', version: '1'}, source: {kind: 'arguments', value: {count: 0}}});

it('normalizes only public call fields and keeps business arguments separate from the legacy Agent adapter', () => {
    const source = {...request(), agentId: 'forged', instructionFlowBinding: {definition: 'forged'}, invocation: {invocationId: 'forged'}};
    const input = submissionInstruction(source as SubmissionRequest);
    expect(input).toMatchObject({target: {kind: 'flow', id: 'worker', version: '1'}, agentId: '', text: '', source: request().source,
        sendIntent: {execution: {kind: 'flow', flowId: 'worker', revision: 1}}});
    expect(input).not.toHaveProperty('instructionFlowBinding'); expect(input).not.toHaveProperty('invocation');
    (source.source as {value: {count: number}}).value.count = 2;
    expect(input.source).toEqual(request().source);
});

it.each(['0', '-1', '1.0', '01', '9007199254740992'])('rejects noncanonical Flow versions before queue work: %s', version => {
    expect(() => submissionInstruction({...request(), target: {kind: 'flow', id: 'worker', version}})).toThrow('positive revision');
});

it.each([
    {source: {kind: 'arguments', value: {count: Infinity}}},
    {source: {kind: 'composer', text: '', attachments: [], values: {}, unexpected: 'not accepted'}},
    {submission: {id: 'bad id', source: {kind: 'conversation', id: 'x', ownerId: 's'}}},
    {submission: {id: 'ok', source: {kind: '', id: 'x', ownerId: 's'}}},
    {expectedTarget: {kind: 'agent', id: 'worker', version: '1', digest: 'other'}},
    {attachments: [{name: 'raw', type: 'text/plain', fileRef: {}}]},
    {presentation: {text: 5}},
    {presentation: {text: 'Label', policy: 'injected'}},
])('rejects malformed or unprepared caller data without JSON coercion: %j', patch => {
    expect(() => submissionInstruction({...request(), ...patch} as SubmissionRequest)).toThrow();
});

it('keeps presentation out of executable arguments and preserves explicit branch controls', () => {
    const input = submissionInstruction({...request(), presentation: {text: 'Original editor text'},
        overrides: {branchMode: 'fork', baseRoundId: 'previous', newBranchName: 'review', retentionMode: 'temporary'}});
    expect(input.text).toBe('Original editor text'); expect(input.source).toEqual(request().source);
    expect(input.sendIntent).toMatchObject({branch: {mode: 'fork', baseRoundId: 'previous', newBranchName: 'review'}, retention: {mode: 'temporary'}});
    expect(() => submissionInstruction({...request(), source: {kind: 'composer', text: 'Actual input', attachments: [], values: {}},
        presentation: {text: 'Conflicting input'}})).toThrow('Presentation text');
});
