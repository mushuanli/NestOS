import type { ToolVFSContext } from '../contracts';
import { ToolInputError } from './tool-error';

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

export async function readToolFile(vfs: ToolVFSContext, path: string): Promise<string> {
  try { return await vfs.readFile(path); }
  catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new ToolInputError(String(code), `Cannot read file ${path}: ${String(code)}`);
    }
    throw error;
  }
}

export async function toolFileExists(vfs: ToolVFSContext, path: string): Promise<boolean> {
  if (vfs.stat) return await vfs.stat(path) !== null;
  try { await vfs.readFile(path); return true; }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
