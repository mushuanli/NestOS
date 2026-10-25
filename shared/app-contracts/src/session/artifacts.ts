/** Read models derived from committed Kernel outputs; they are not another artifact store. */
export const ArtifactCommand = {List: 'app.artifacts.list', Read: 'app.artifacts.read'} as const;

export interface ExecutionArtifactReference {kind: 'task-output'; sessionId: string; taskId: string; artifactId: string;}
export interface ExecutionArtifactScope {sessionId: string; taskId: string;}
export interface ExecutionArtifactDescriptor {
    reference: ExecutionArtifactReference;
    taskId: string;
    invocationId?: string;
    outputName: string;
    name: string;
    kind: 'text' | 'json' | 'binary' | 'unavailable';
    mimeType: string;
    bytes?: number;
    sha256?: string;
    unavailableReason?: string;
}
export interface ListExecutionArtifacts extends ExecutionArtifactScope {offset?: number; limit?: number; operationId?: string;}
export interface ExecutionArtifactPage extends ExecutionArtifactScope {items: ExecutionArtifactDescriptor[]; nextOffset?: number;}
export interface ReadExecutionArtifact {
    reference: ExecutionArtifactReference;
    offset?: number;
    limit?: number;
    operationId?: string;
}
export interface ExecutionArtifactChunk {
    reference: ExecutionArtifactReference;
    offset: number;
    totalBytes: number;
    nextOffset?: number;
    sha256: string;
    mimeType: string;
    data: ArrayBuffer;
}
