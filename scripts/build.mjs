import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_FILES } from './package-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function dependencyNotices(inputs) {
  const packages = new Set();
  for (const input of inputs) {
    const parts = input.replaceAll('\\', '/').split('/');
    const index = parts.lastIndexOf('node_modules');
    if (index !== -1) packages.add(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/'));
  }
  const dependencies = [];
  const text = ['Memory House bundled runtime: third-party notices', 'These dependency licenses are preserved with their bundled code.', ''];
  for (const directory of [...packages].sort(sort)) {
    const root = join(ROOT, directory);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const licenses = (await readdir(root)).filter(name => /^(license|copying|notice)([._-].*)?$/i.test(name)).sort(sort);
    if (!licenses.length) throw new Error(`Missing license text for ${pkg.name}`);
    dependencies.push({ name: pkg.name, version: pkg.version, license: pkg.license });
    text.push(`===== ${pkg.name}@${pkg.version} (${pkg.license}) =====`);
    for (const file of licenses) {
      if (!(await lstat(join(root, file))).isFile()) throw new Error(`Invalid license file in ${pkg.name}`);
      text.push(`--- ${file} ---`, (await readFile(join(root, file), 'utf8')).replace(/\r\n?/g, '\n'));
    }
  }
  return { dependencies, text: Buffer.from(text.join('\n')) };
}

async function generatedRuntime() {
  const target = join(ROOT, 'runtime');
  const bundled = await build({
    absWorkingDir: ROOT, entryPoints: { server: 'src/server.mjs', hook: 'src/hook.mjs', auth: 'src/auth.mjs' },
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
    nodePaths: [join(ROOT, '.maintainer', 'node_modules')],
    outdir: target, outExtension: { '.js': '.mjs' }, chunkNames: 'shared-[hash]',
    write: false, metafile: true, logLevel: 'silent', legalComments: 'eof', minify: true,
    banner: { js: "import { createRequire as __mhCreateRequire } from 'node:module'; const require = __mhCreateRequire(import.meta.url);" },
  });
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  for (const output of Object.values(bundled.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !builtins.has(imported.path)) throw new Error(`Unbundled dependency: ${imported.path}`);
    }
  }
  const inputs = Object.keys(bundled.metafile.inputs).sort(sort);
  const license = await dependencyNotices(inputs);
  const files = new Map(bundled.outputFiles.map(file => [basename(file.path), Buffer.from(file.contents)]));
  files.set('THIRD_PARTY_NOTICES.txt', license.text);
  const sourcePaths = [
    ...inputs.filter(path => !path.replaceAll('\\', '/').includes('node_modules/')),
    'scripts/build.mjs', 'scripts/package-files.mjs', 'package.json',
    '.maintainer/package.json', '.maintainer/package-lock.json', '.maintainer/register.mjs', '.maintainer/resolve.mjs',
  ].sort(sort);
  const sources = {};
  for (const path of sourcePaths) sources[path.replaceAll('\\', '/')] = hash(await readFile(join(ROOT, path)));
  const packaged = {};
  for (const path of PACKAGE_FILES) packaged[path] = hash(await readFile(join(ROOT, path)));
  const outputs = Object.fromEntries([...files].sort(([a], [b]) => sort(a, b)).map(([name, contents]) => [name, hash(contents)]));
  files.set('manifest.json', json({
    producer: 'memory-house-root', version: 1, esbuildVersion,
    sources, packageFiles: packaged, dependencies: license.dependencies, outputs,
  }));
  return files;
}

export async function buildRuntime({ outputRoot = join(ROOT, 'runtime'), check = false } = {}) {
  outputRoot = resolve(outputRoot);
  if (outputRoot === ROOT || dirname(outputRoot) === outputRoot) throw new Error('Use a dedicated runtime output directory.');
  const next = await generatedRuntime();
  const stat = await existing(outputRoot);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Runtime must be a regular owned build directory.');
  let prior = {};
  let priorManifest;
  if (stat) {
    const names = (await readdir(outputRoot)).sort(sort);
    if (names.length) {
      if (!names.includes('manifest.json')) throw new Error('Refusing to overwrite an unrecognized runtime directory.');
      const manifestStat = await lstat(join(outputRoot, 'manifest.json'));
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('Invalid runtime manifest path.');
      const raw = await readFile(join(outputRoot, 'manifest.json'));
      priorManifest = hash(raw);
      const manifest = JSON.parse(raw.toString('utf8'));
      if (manifest.producer !== 'memory-house-root') throw new Error('Unrecognized runtime producer.');
      prior = manifest.outputs;
      if (names.join('\n') !== [...Object.keys(prior), 'manifest.json'].sort(sort).join('\n')) throw new Error('Runtime contains unrecognized files.');
      for (const [name, expected] of Object.entries(prior)) {
        if (basename(name) !== name || name.includes('\\') || name.includes(':')) throw new Error('Invalid runtime output path.');
        const path = join(outputRoot, name);
        const current = await lstat(path);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || hash(await readFile(path)) !== expected) {
          throw new Error(`Generated runtime contains local edits: ${name}`);
        }
      }
    }
  }
  if (check) {
    if (!stat || (await readdir(outputRoot)).length !== next.size) throw new Error('Bundled runtime is missing or stale. Maintainers must run npm run build before publication.');
    for (const [name, content] of next) {
      if (!(await existing(join(outputRoot, name))) || !(await readFile(join(outputRoot, name))).equals(content)) {
        throw new Error(`Bundled runtime is stale: ${name}. Maintainers must run npm run build.`);
      }
    }
  } else {
    await mkdir(outputRoot, { recursive: true });
    for (const [name, content] of next) {
      const path = join(outputRoot, name);
      const stage = `${path}.build-stage`;
      let created = false;
      let handle;
      try {
        handle = await open(stage, 'wx', 0o644);
        created = true;
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = undefined;
        const expected = name === 'manifest.json' ? priorManifest : prior[name];
        const current = await existing(path);
        if (expected) {
          if (!current?.isFile() || current.isSymbolicLink() || hash(await readFile(path)) !== expected) {
            throw new Error(`Generated runtime changed during rebuild: ${name}`);
          }
          await rename(stage, path);
          created = false;
        } else {
          await link(stage, path);
          await unlink(stage);
          created = false;
        }
        await chmod(path, 0o644);
      } finally {
        if (handle) await handle.close();
        if (created) await unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    for (const name of Object.keys(prior)) if (!next.has(name)) await unlink(join(outputRoot, name));
  }
  return { outputRoot, files: Object.fromEntries([...next].map(([name, value]) => [name, hash(value)])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildRuntime({ check: process.argv.includes('--check') });
  process.stdout.write(`${process.argv.includes('--check') ? 'Verified' : 'Built'} ${Object.keys(result.files).length} bundled files in ${relative(ROOT, result.outputRoot).split(sep).join('/')}.\n`);
}
