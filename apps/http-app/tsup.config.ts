import { defineConfig } from 'tsup';

export default defineConfig({
    // Bundle the source-only profile entry for plain Node startup.
    banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
    noExternal: [/^@itookit\/(?:app-core|vfs-core|vfsdriver-local)(?:\/|$)/],
});
