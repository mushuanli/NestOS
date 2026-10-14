/** Small public entry point. Legacy APIs and diagnostic records remain in the root export. */
import { Kernel, type KernelOptions } from './application/kernel';
import type { SessionHandle, TaskHandle, TaskSpec } from './domain/types';

export type Task<O = unknown> = Pick<TaskHandle<O>,
    'id' | 'resources' | 'cache' | 'send' | 'stat' | 'stats' | 'watch' | 'wait' | 'poll' | 'start'
    | 'pause' | 'interrupt' | 'resume' | 'cancel' | 'signal' | 'respond'>;
export interface Session extends Pick<SessionHandle, 'id' | 'resources' | 'stat' | 'watch' | 'suspend' | 'resume' | 'close' | 'recover'> {
    spawn<I, O = unknown>(spec: TaskSpec<I>): Promise<Task<O>>;
    attachTask<O = unknown>(id: string): Promise<Task<O>>;
}
export interface Harness extends Pick<Kernel, 'initialize' | 'dispose' | 'waitIdle' | 'recover' | 'recoverSession' | 'resources'
    | 'registerProgram' | 'registerResourceAdapter' | 'registerEffect' | 'registerStorageResolver' | 'registerWorkspace' | 'use'> {
    createSession(spec: Parameters<Kernel['createSession']>[0]): Promise<Session>;
    openSession(id: string): Promise<Session>;
    openTask<O = unknown>(id: string): Promise<Task<O>>;
}
export function createHarness(options: KernelOptions): Harness { return new Kernel(options); }
export { resourceResult } from './public/resources';
export { defineTask, type TaskStepEvent } from './public/program';
export type { ManagedResource as Resource, ManagedResourceRef as ResourceRef, ManagedHandle as ResourceHandle } from './domain/resource-api';
export type { KernelOptions } from './application/kernel';
export type { ManagedResourceAdapter, ResourceCleanupContext, ResourceCleanupReceipt, PhysicalResourceBinding, ResourceCleanup, ManagedGrant, ResourceQuery, ResourcePage, ResourceRequestInfo, ResourceApi, ManagedResource, ManagedResourceRef, ManagedHandle, ResourceClaim, ResourceCommand, DurableResourceRequest } from './domain/resource-api';
export type { TaskStat, TaskStats, SessionStat } from './domain/status';
export type { CacheApi, CacheSpec, CacheRead, CachePublish } from './domain/cache';
export type { RecoveryOptions, RecoveryReport, DurableTaskProgram, Decision, TaskInputEvent, KernelAction, EffectAdapter, SessionStorageResolver } from './domain/types';
