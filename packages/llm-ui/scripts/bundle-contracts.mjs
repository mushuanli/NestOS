import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsup's declaration resolver does not honor npm subpath exports. Resolve these
// contracts with TypeScript while retaining the identity of the public UI ports.
const root = fileURLToPath(new URL('../', import.meta.url));
const entries = ['index', 'chat', 'startup', 'settings', 'conversation'];
const bundle = await rollup({
    input: Object.fromEntries(entries.map(name => [name, resolve(root, `dist/${name}.d.ts`)])),
    external: id => !id.startsWith('.') && !id.startsWith('/') && id !== '@itookit/driver-llm/contracts',
    plugins: [dts({ respectExternal: true, tsconfig: resolve(root, 'tsconfig.json') })],
});
try {
    await bundle.write({ dir: resolve(root, 'dist'), format: 'es', entryFileNames: '[name].d.ts', chunkFileNames: 'contracts-[hash].d.ts' });
} finally { await bundle.close(); }
