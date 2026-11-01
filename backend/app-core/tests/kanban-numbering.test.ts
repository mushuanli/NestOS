import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {KanbanCommand, KanbanClient} from '@itookit/kanban/contracts';
import {kanbanReference} from '@itookit/kanban/contracts';
import {createNestOSKanban} from '../src/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import {KanbanError} from '@itookit/kanban';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async()=>{for(const close of cleanup.splice(0)) await close();});
async function fixture() {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()}); cleanup.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'), store=await SeqKanbanStore.open(fs);
    const service=(authorize:()=>Promise<void>=async()=>{})=>createNestOSKanban({store,actor:{kind:'human',id:'admin'},authorize,log:()=>{}});
    const input=(id:string)=>({id,title:id,scope:{kind:'system' as const},members:[{kind:'human' as const,id:'admin',responsibility:'Manage',roles:['worker','coordinator'] as Array<'worker'|'coordinator'>}],policy:{requireEstimate:false,review:'assignee' as const}});
    let serial=0;
    const run=async(api:KanbanClient,id:string,command:KanbanCommand,operationId=`op-${++serial}`)=>api.execute(id,{operationId,expectedRevision:(await api.read(id)).revision,command});
    const item=(id:string)=>({type:'create-item' as const,item:{id,title:id,responsibility:'Work',acceptance:'Evidence'},planning:{kind:'feature',priority:2,dependencies:[],references:[]}});
    return {fs,store,service,input,run,item};
}
it('allocates unique board numbers atomically across instances and keeps creation retries stable',async()=>{
    const f=await fixture(), a=f.service(), b=f.service();
    const boards=await Promise.all([a.create(f.input('a')),b.create(f.input('b'))]);
    expect(boards.map(board=>board.number).sort()).toEqual([1,2]);
    expect((await a.create(f.input('a'))).number).toBe(boards[0].number);
    expect(await f.fs.meta.seq!.getEntry('/kanban/boards.seq','counter/board')).toBe('2');
    expect((await f.service().read('a')).number).toBe(boards[0].number);
    expect((await a.resolve(`KB-${boards[0].number}`)).boardId).toBe('a');
});
it('numbers work, logs and decisions separately and preserves references through archive and restore',async()=>{
    const f=await fixture(), api=f.service(), board=await api.create(f.input('b'));
    await f.run(api,'b',f.item('first'));await f.run(api,'b',f.item('second'));
    const first=(await api.item('b','first')).item;expect(first.number).toBe(1);
    await f.run(api,'b',{type:'close-plan',itemId:'first',resultRef:'verified'});
    await f.run(api,'b',{type:'archive-items',itemIds:['first'],reason:'Delivered'});
    expect((await api.resolve('KB-1#1')).itemId).toBe('first');
    expect((await api.item('b','first')).item.number).toBe(1);
    await f.run(api,'b',{type:'restore-item',itemId:'first'});
    expect(kanbanReference(board,(await api.item('b','first')).item)).toBe('KB-1#1');
    for(const kind of ['log','decision'] as const) await f.run(api,'b',{type:'append-record',record:{id:kind,kind,title:kind,content:'Notes',rationale:kind==='decision'?'Reason':undefined,itemIds:['first'],sources:[]}});
    expect((await api.resolve('kb-1/l-1')).recordId).toBe('log');expect((await api.resolve('KB-1/D-1')).recordId).toBe('decision');
    expect((await api.query('b',{view:'all',search:'KB-1#2'})).items.map(item=>item.id)).toEqual(['second']);
    expect((await api.suggest('b',{kind:'item',search:'KB-1#2'})).items[0].id).toBe('second');
    expect((await api.suggest('b',{kind:'decision',search:'KB-1/D-1'})).items).toEqual([]);
});
it('does not accept caller-assigned numbers, consume numbers on failed writes or reuse deleted numbers',async()=>{
    const f=await fixture(), api=f.service();await api.create({...f.input('b'),number:999} as never);
    await f.run(api,'b',{...f.item('first'),item:{...f.item('first').item,number:999}} as never);
    expect((await api.item('b','first')).item.number).toBe(1);
    await expect(f.run(api,'b',f.item('first'))).rejects.toMatchObject({code:'ITEM_EXISTS'});
    await f.store.update('b','delete','delete',state=>{state!.board.items=[];return state!;});
    await f.run(api,'b',f.item('new'));expect((await api.item('b','new')).item.number).toBe(2);
    expect((await api.read('b')).number).toBe(1);
});
it('keeps references scoped to their store and checks board access before resolving entities',async()=>{
    const a=await fixture(), b=await fixture();await a.service().create(a.input('one'));await b.service().create(b.input('two'));
    expect((await a.service().resolve('KB-1')).boardId).toBe('one');expect((await b.service().resolve('KB-1')).boardId).toBe('two');
    await expect(a.service(async()=>{throw new KanbanError('FORBIDDEN');}).resolve('KB-1')).rejects.toMatchObject({code:'FORBIDDEN'});
    for(const text of ['KB-0','KB-1#0','KB-9007199254740992','KB-1/x-1']) await expect(a.service().resolve(text)).rejects.toMatchObject({code:'INVALID_REFERENCE'});
    await expect(a.service().resolve('KB-2')).rejects.toMatchObject({code:'REFERENCE_NOT_FOUND'});
});

it('backfills legacy identities on the next write and preserves old archive references',async()=>{
    const f=await fixture(), api=f.service();await api.create(f.input('b'));await f.run(api,'b',f.item('old'));
    await f.run(api,'b',{type:'close-plan',itemId:'old',resultRef:'verified'});
    await f.run(api,'b',{type:'archive-items',itemIds:['old'],reason:'Done'});
    const state=(await f.store.read('b'))!;delete state.board.number;delete state.numbering;
    for(const item of state.archiveIndex!) delete item.number;
    const archive=await f.store.archived('b','old');delete archive!.item.number;
    const path='/kanban/boards.seq';
    await f.fs.meta.seq!.setEntry(path,'board/b',JSON.stringify(state));await f.fs.meta.seq!.setEntry(path,'archive/b/old',JSON.stringify(archive));
    await f.fs.meta.seq!.deleteEntry(path,'counter/board');await f.fs.meta.seq!.deleteEntry(path,'reference/board/1');
    expect((await api.read('b')).number).toBeUndefined();
    await f.run(api,'b',f.item('new'));
    const board=await api.read('b');expect(board.id).toBe('b');expect(board.number).toBe(1);
    const old=(await api.item('b','old')).item;expect(old.number).toBeDefined();
    expect((await api.resolve(`KB-1#${old.number}`)).itemId).toBe('old');
    await f.run(api,'b',{type:'restore-item',itemId:'old'});expect((await api.item('b','old')).item.number).toBe(old.number);
});

it('rejects a damaged counter instead of overwriting another board reference',async()=>{
    const f=await fixture(), api=f.service();await api.create(f.input('a'));
    await f.fs.meta.seq!.setEntry('/kanban/boards.seq','counter/board','0');
    await expect(api.create(f.input('b'))).rejects.toMatchObject({code:'INVALID_NUMBERING'});
    expect((await api.resolve('KB-1')).boardId).toBe('a');expect(await f.store.read('b')).toBeNull();
});
