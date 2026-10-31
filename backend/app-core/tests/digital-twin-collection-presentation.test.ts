import {expect, it} from 'vitest';
import {presentCollectionTools} from '../src/digital-twin/collection-tools';
import type {TwinScannerTool} from '@itookit/app-contracts';
import type {ToolPackageInfo} from '@itookit/app-contracts/services';

it('projects generic package presentation without changing fixed Tool identity or hiding an existing compatibility target', () => {
    const tools: TwinScannerTool[] = ['fixture.collect', 'fixture.legacy'].map(id => ({target: {kind: 'tool', id, version: '1', digest: id},
        name: id, description: '', source: 'plugin', parameters: {type: 'object'}, defaults: {count: 4}}));
    const packages: ToolPackageInfo[] = [{id: 'fixture', version: '2', status: 'registered', tools: [], configuration: {enabled: true, defaults: {}, tools: [
        {id: 'fixture.collect', label: 'Collect', advanced: ['count'], optionLabels: {account: {personal: 'Personal'}}, parameters: [{name: 'account', type: 'string', options: ['personal']}]},
        {id: 'fixture.legacy', hidden: true, parameters: []}]}}];
    const result = presentCollectionTools(tools, packages);
    expect(result[0]).toMatchObject({name: 'Collect', presentation: {advanced: ['count'], optionLabels: {account: {personal: 'Personal'}}}});
    expect(result.map(item => item.target)).toEqual(tools.map(item => item.target));
    expect(result[1].hidden).toBe(true);
    expect(result[0].defaults).toEqual({count: 4});
    expect(presentCollectionTools(tools, [{...packages[0], status: 'available'}])).toEqual(tools);
});
