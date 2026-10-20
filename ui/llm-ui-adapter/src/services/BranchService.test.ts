import {expect, it, vi} from 'vitest';
import {BranchService} from './BranchService';

it('continues at the selected user round without shifting backward or switching by a shared head', async () => {
    const execute = vi.fn(async () => 'shared-head');
    const service = new BranchService({execute} as never, {current: [
        {name: 'main', headNodeId: 'shared-head', isCurrent: false},
        {name: 'new', headNodeId: 'shared-head', isCurrent: true},
    ]} as never);
    await service.create('selected-user', 'new');
    expect(execute.mock.calls).toEqual([['vcs.branch.create', {branchNodeId: 'selected-user', options: {name: 'new'}}]]);
});

it('does not silently switch to the first branch when multiple refs share a head', async () => {
    const execute = vi.fn(async () => [{name: 'main', headNodeId: 'shared'}, {name: 'new', headNodeId: 'shared'}]);
    const service = new BranchService({execute} as never, {current: []} as never);
    await expect(service.switchById('shared')).rejects.toMatchObject({code: 'AMBIGUOUS_TARGET'});
    expect(execute).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith('vcs.branch.list');
});
