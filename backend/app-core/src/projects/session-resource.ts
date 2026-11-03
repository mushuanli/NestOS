import {remoteSessionPath} from '@itookit/app-contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import type {ProjectRemoteMountService} from './remote-mounts';
import {readContextCatalog,type ContextInspector} from './harness-context-catalog';

/** Resolve a single confirmed native context without opening a Session or acquiring a writer. */
export function nativeSessionResource(kernel:ContextInspector,projects:Pick<ProjectService,'list'>,remote:Pick<ProjectRemoteMountService,'list'>) {
    return async(sessionId:string,branch:string):Promise<string|undefined>=>{
        const catalog=await readContextCatalog(kernel,sessionId);
        const bindings=Object.values(catalog.value.bindings).filter(binding=>binding.branchId===branch&&binding.validity==='valid'&&binding.nativeRef);
        if(bindings.length!==1)return;
        const native=bindings[0].nativeRef!;
        const folders=(await projects.list()).filter(folder=>folder.project&&remote.list(folder.project.id).some(root=>
            root.at==='/'&&root.connectionId===native.nodeConnectionId&&root.serverProjectId===native.workspaceId));
        if(folders.length!==1)return;
        return remoteSessionPath(folders[0].path,native.profileId,native.sessionId);
    };
}
