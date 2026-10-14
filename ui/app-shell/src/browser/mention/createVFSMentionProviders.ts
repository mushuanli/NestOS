/**
 * @file app-shell/src/browser/mention/createVFSMentionProviders.ts
 * @desc Factory for creating VFS-backed mention providers.
 *
 * System file filtering (. prefix, __ prefix, _ asset dirs) is handled
 * automatically by shouldFilterNode() inside each provider's filterResults().
 */
import type { IFileSystem } from '@itookit/vfs-core';
import { FileMentionSource } from './FileMentionSource';
import { DirectoryMentionSource } from './DirectoryMentionSource';

/**
 * Creates a standard set of VFS mention providers (files + directories).
 *
 * @param engine  - The module file system for the current workspace
 * @param scope   - Search scope: ['*'] = global, ['mod1','mod2'] = specific modules,
 *                  undefined = default (global). Empty array disables cross-module search.
 */
export function createVFSMentionProviders(
  engine: IFileSystem,
  scope?: string[]
) {
  if (scope !== undefined && scope.length === 0) return [];

  const deps = { engine, scope };
  return [
    new FileMentionSource(deps),
    new DirectoryMentionSource(deps),
  ];
}
