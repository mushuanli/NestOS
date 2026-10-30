// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {studyDraftStore} from '../src/persistence/study-draft-store';
import {FileRecoveryStore,setFileRecoveryOwner} from '../src/persistence/file-recovery-store';
afterEach(()=>{sessionStorage.clear();setFileRecoveryOwner('');});
const state={version:1 as const,draftId:'stable',title:'Title',source:'Source',prompt:'Prompt',content:'--answer--',generated:''};
it('keeps creation recovery isolated by authenticated user and workspace',async()=>{
 const signal=new AbortController().signal;setFileRecoveryOwner('admin');const admin=studyDraftStore('notes');await admin.save(state);
 setFileRecoveryOwner('alice');expect(await studyDraftStore('notes').load(signal)).toBeUndefined();
 await studyDraftStore('notes').save({...state,content:'Alice'});setFileRecoveryOwner('admin');
 expect(await studyDraftStore('notes').load(signal)).toEqual(state);expect(await studyDraftStore('other').load(signal)).toBeUndefined();
 await admin.clear();expect(await admin.load(signal)).toBeUndefined();
});
it('rejects malformed recovery instead of restoring executable links or invalid field types',async()=>{
 const store=studyDraftStore('notes'),signal=new AbortController().signal;
 await store.save({...state,execution:{label:'Invalid',url:'javascript:alert(1)'}});
 await expect(store.load(signal)).rejects.toMatchObject({code:'STUDY_DRAFT_INVALID'});
 await store.clear();
 await store.save({...state,pendingOperationId:12} as never);
 await expect(store.load(signal)).rejects.toMatchObject({code:'STUDY_DRAFT_INVALID'});
});
it('reports unavailable browser storage with a specific safe error code',async()=>{
 const {vi}=await import('vitest');const get=vi.spyOn(FileRecoveryStore.prototype,'write').mockRejectedValueOnce(new Error('private storage error'));
 try{await expect(studyDraftStore('notes').save(state)).rejects.toMatchObject({code:'STUDY_DRAFT_STORAGE_UNAVAILABLE'});}finally{get.mockRestore();}
});
