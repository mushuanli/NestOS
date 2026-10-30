import {afterEach,expect,it,vi} from 'vitest';
import {reportClientDiagnostic} from '../src/host/client-diagnostic';
afterEach(()=>vi.restoreAllMocks());
const diagnostic={operation:'text.result',operationId:'op',sessionId:'session',stage:'query-wait',code:'TEXT_RESULT_QUERY_TIMEOUT',result:'retrying' as const,durationMs:10000};
it('writes only bounded client metadata to the host runtime log',()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 reportClientDiagnostic(diagnostic);expect(warn).toHaveBeenCalledWith('[ClientDiagnostic]',expect.objectContaining({...diagnostic,source:'client'}));
});
it.each([{...diagnostic,prompt:'secret'}, {...diagnostic,code:'secret content'}, {...diagnostic,durationMs:Infinity}, {...diagnostic,requestId:'id\nsecret'}])('rejects unsupported fields or invalid metadata before logging',value=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 expect(()=>reportClientDiagnostic(value as never)).toThrow(expect.objectContaining({code:'CLIENT_DIAGNOSTIC_INVALID'}));expect(warn).not.toHaveBeenCalled();
});
