import {ArtifactCommand, type ListExecutionArtifacts, type ReadExecutionArtifact} from '@itookit/app-contracts';
import {createModuleLogger} from '@itookit/common';
import type {Kernel} from '@itookit/durable-kernel';
import type {CommandBus} from '@itookit/llm-session';
import type {IFileSystem} from '@itookit/vfs-core';
import {TaskArtifacts} from '../session/task-artifacts';
import {createTaskAssetReader} from './task-assets';

export function createTaskArtifactServices(kernel: Kernel, fs: IFileSystem) {
    const artifacts = new TaskArtifacts(kernel, createTaskAssetReader(() => kernel, fs), createModuleLogger('execution-artifacts'));
    return {loadArtifact: (sessionId: string, id: string) => artifacts.context(sessionId, id),
        register(commands: CommandBus) {
            const list = commands.register(ArtifactCommand.List, args => artifacts.list(args as ListExecutionArtifacts));
            const read = commands.register(ArtifactCommand.Read, args => artifacts.read(args as ReadExecutionArtifact));
            return {dispose() {list.dispose(); read.dispose();}};
        },
    };
}
