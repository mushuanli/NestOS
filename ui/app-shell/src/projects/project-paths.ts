/** Rewrite only routes belonging to the renamed project, including descendants. */
export function remapProjectPath(path: string, from: string, to: string): string {
    return path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path;
}
