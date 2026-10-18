import {expect, it} from 'vitest';
import {inheritDraftPreferences} from '../../llm-ui-adapter/src/shell/drafts/draft-preferences';
import type {IChatInputConfig} from '../../llm-ui-adapter/src/domain/ports/IChatInputPresenter';
import type {ConnectionOption} from '../../llm-ui-adapter/src/domain/types';

const current: IChatInputConfig = {text: 'Target draft', agentId: 'default', settings: {connectionId: 'target', modelTier: 'optimal', executionMode: 'chat'}};
const agents = [{id: 'default', name: 'Default'}, {id: 'writer', name: 'Writer'}];
const connection: ConnectionOption = {id: 'chosen', name: 'Chosen', hasApiKey: true, credentialsReady: true,
    hasTiers: true, tiers: {optimal: 'Model', fast: 'Fast'}, resolvedTiers: {optimal: 'Model', fast: 'Fast'}};
const preferences = {agentId: 'writer', settings: {connectionId: 'chosen', modelTier: 'fast', executionMode: 'agent',
    thinkingEnabled: false, reasoningEffort: 'high', temperature: 0.7, executionModeLocked: true, flowId: 'source-flow'}};

it('inherits valid choices while keeping target text and excluding execution locks and Flow references', () => {
    const result = inheritDraftPreferences(current, preferences, agents, [connection]);
    expect(result).toMatchObject({text: current.text, agentId: 'writer', settings: {connectionId: 'chosen', modelTier: 'fast',
        executionMode: 'agent', thinkingEnabled: false, reasoningEffort: 'high', temperature: 0.7}});
    expect(result.settings).not.toHaveProperty('flowId'); expect(result.settings).not.toHaveProperty('executionModeLocked');
    expect(current.settings.connectionId).toBe('target');
});

it.each(['missing', 'disabled', 'unauthorized'])('keeps the target connection when the source is %s', reason => {
    const candidate = {...connection, ...(reason === 'disabled' ? {enabled: false} : {}),
        ...(reason === 'unauthorized' ? {credentialsReady: false} : {}),
        ...(reason === 'model-missing' ? {resolvedTiers: {optimal: 'Model', fast: null}} : {})};
    const result = inheritDraftPreferences(current, preferences, agents, reason === 'missing' ? [] : [candidate]);
    expect(result.settings).toMatchObject({connectionId: 'target', modelTier: 'optimal', executionMode: 'agent'});
});

it('keeps the target agent when the chosen agent is unavailable', () => {
    expect(inheritDraftPreferences(current, {...preferences, agentId: 'deleted'}, agents, [connection]).agentId).toBe('default');
});

it('carries an explicit follow-default choice instead of retaining the target explicit connection', () => {
    const result = inheritDraftPreferences(current, {settings: {connectionId: undefined, modelTier: 'auto'}}, agents, [{...connection, isDefault: true}]);
    expect(result.settings.connectionId).toBeUndefined(); expect(result.settings.modelTier).toBe('auto');
});

it('does not carry local connection or mode preferences into a remote harness', () => {
    const target = {...current, agentId: 'remote:target'};
    const result = inheritDraftPreferences(target, preferences, [{id: 'remote:target', name: 'Harness'}], [connection], true);
    expect(result).toEqual(target);
});

it('does not carry hidden local settings from a remote harness into a local project', () => {
    expect(inheritDraftPreferences(current, {...preferences, agentId: 'remote:source'}, agents, [connection])).toEqual(current);
});

it('carries an available connection and retains a supported target tier when the source tier is unavailable', () => {
    const candidate = {...connection, resolvedTiers: {optimal: 'Model', fast: null}};
    const result = inheritDraftPreferences(current, preferences, agents, [candidate]);
    expect(result.settings).toMatchObject({connectionId: 'chosen', modelTier: 'optimal'});
});
