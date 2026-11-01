import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0)) await close();});
it('wires change-driven reconciliation, reports recovery errors globally and stops the integration once',async()=>{
    const error=Object.assign(new Error('private data'),{code:'WORKER_UNAVAILABLE'}),scan=vi.fn(async()=>{throw error;}),quiesce=vi.fn(async()=>{});
    const runtime=await createApplicationRuntime({backend:new MemoryBackend(),startupMode:'interactive',digitalTwinAutoStart:false,
        configureKanban:async context=>{expect(typeof context.kernel.task).toBe('function');expect(context.sessions).toBeDefined();return [{scan,quiesce}];}});
    closes.push(()=>runtime.dispose());runtime.startBackground();
    await vi.waitFor(async()=>expect((await runtime.events.listNotifications()).items.some(item=>item.event.value.type==='kanban.runtime.WORKER_UNAVAILABLE')).toBe(true));
    const count=scan.mock.calls.length;
    await runtime.kanban!.create({id:'wake',title:'Wake',scope:{kind:'system'},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['coordinator','worker']} ]});
    await vi.waitFor(()=>expect(scan.mock.calls.length).toBeGreaterThan(count));
    const notifications=await runtime.events.listNotifications();
    expect(notifications.items.filter(item=>item.event.value.type==='kanban.runtime.WORKER_UNAVAILABLE')).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toContain('private data');await runtime.dispose();expect(quiesce).toHaveBeenCalledTimes(1);
    await expect(runtime.kanban!.read('wake')).rejects.toMatchObject({code:'SERVICE_STOPPING'});
});
it('continues releasing the backend when an integration rejects shutdown',async()=>{
    const backend=new MemoryBackend(),close=vi.spyOn(backend,'close'),quiesce=vi.fn(async()=>{throw new Error('shutdown failed');});
    const runtime=await createApplicationRuntime({backend,startupMode:'interactive',digitalTwinAutoStart:false,configureKanban:async()=>[{scan:async()=>{},quiesce}]});
    closes.push(async()=>{await runtime.dispose().catch(()=>{});});
    await expect(runtime.dispose()).rejects.toBeInstanceOf(AggregateError);expect(close).toHaveBeenCalledTimes(1);expect(quiesce).toHaveBeenCalledTimes(1);
});
