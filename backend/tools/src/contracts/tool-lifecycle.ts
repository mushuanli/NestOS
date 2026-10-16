import type { ToolInvokeResult, ToolInvokeRequest } from './tool-types';
export interface ToolExecutionIdentity { operationId: string; sessionId: string; taskId: string; effectId: string }
export type ToolReconcileResult = { status: 'completed'; data: unknown } | { status: 'retry' } | { status: 'indeterminate'; error?: { message: string; code?: string } };
export type ToolServiceReconcileResult = { status: 'completed'; result: ToolInvokeResult } | { status: 'retry' } | { status: 'indeterminate'; error: { message: string; code?: string } };
export type ToolReconcileRequest = ToolInvokeRequest & ToolExecutionIdentity;
