import {readToolPackageRegistry, withToolPackageRegistry, writeToolPackageRegistry} from '../src/runtime/tool-packages/store';

const [file, id, delay] = process.argv.slice(2);
await withToolPackageRegistry(file, async () => {
    const current = await readToolPackageRegistry(file); process.stdout.write('locked\n');
    await new Promise(resolve => setTimeout(resolve, Number(delay)));
    await writeToolPackageRegistry(file, current.concat({id, version: '1', fingerprint: 'a'.repeat(64), bindings: []}));
});
