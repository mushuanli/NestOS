import {expect,it,vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {ProjectEnvironmentStore,withProjectEnvironment} from '../src/projects/project-environment';
it('persists project-isolated environments and rejects stale writes and invalid values',async () => {
    const {manager} = await createVFS({rootBackend:new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new ProjectEnvironmentStore(fs);
        expect(await store.read('local')).toEqual({revision:0,variables:{}});
        await store.save('local',0,{GIT_AUTHOR_NAME:'Rain Li'});
        expect(await new ProjectEnvironmentStore(fs).read('local')).toEqual({revision:1,variables:{GIT_AUTHOR_NAME:'Rain Li'}});
        expect(await store.read('other')).toEqual({revision:0,variables:{}});
        await expect(store.save('local',0,{KEY:'stale'})).rejects.toMatchObject({code:'ECONFLICT'});
        for (const variables of [{'BAD=KEY':'x'},{LD_PRELOAD:'x'},{KEY:'a\0b'}]) await expect(store.save('local',1,variables)).rejects.toThrow();
        expect((await store.read('local')).variables).toEqual({GIT_AUTHOR_NAME:'Rain Li'});
    } finally {await manager.dispose();}
});
it('passes defaults into shell and TTY options without changing host state or resource ownership',async () => {
    const exec = vi.fn(async () => ({stdout:'',stderr:'',code:0})), spawn = vi.fn(), release = vi.fn();
    const context = {nativeShell:{capabilities:{ripgrep:false,fd:false},exec},ttyDriver:{supportsPty:true,spawn},release};
    const variables = {PROJECT_KEY:'literal $(value)',OVERRIDE:'base'};
    const configured = withProjectEnvironment(context as never,variables); variables.PROJECT_KEY = 'later mutation';
    await configured.nativeShell!.exec('sh',['-c','echo test'],{env:{OVERRIDE:'explicit'}});
    expect(exec).toHaveBeenCalledWith('sh',['-c','echo test'],{env:{PROJECT_KEY:'literal $(value)',OVERRIDE:'explicit'}});
    configured.ttyDriver!.spawn('sh',[],{});
    expect(spawn).toHaveBeenCalledWith('sh',[],{env:{PROJECT_KEY:'literal $(value)',OVERRIDE:'base'}});
    expect(configured.release).toBe(release);
});

it('snapshots variables before asynchronous storage and classifies corrupt saved records',async () => {
    const {manager} = await createVFS({rootBackend:new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new ProjectEnvironmentStore(fs);
        const variables = {KEY:'original'};
        const saving = store.save('local',0,variables);
        variables.KEY = 'changed'; Object.assign(variables,{LD_PRELOAD:'forged'});
        await saving;
        expect((await store.read('local')).variables).toEqual({KEY:'original'});
        await fs.meta.seq!.setEntry('/var/lib/projects/local/settings.seq','environment','{broken');
        await expect(store.read('local')).rejects.toMatchObject({code:'EIO'});
        await expect(store.save('local',1,{KEY:'next'})).rejects.toMatchObject({code:'EIO'});
    } finally {await manager.dispose();}
});
