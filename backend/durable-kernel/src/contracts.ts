/** Data and capability contracts without kernel construction or storage implementation. */
export type * from './domain/types';
export type * from './domain/resource-api';
export type { CacheApi } from './domain/cache';
export type { TaskStat, TaskStats, SessionStat } from './domain/status';
export type * from './ports/task-control';
export type { KernelViewPort, KernelInspectionPort, KernelChangeReason } from './ports/kernel-view';
