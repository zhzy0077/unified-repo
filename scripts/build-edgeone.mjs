// Bundle the shared core into a self-contained EdgeOne Makers artifact.
// Each route file is a standalone ESM module with no imports, so EdgeOne's
// per-file bundler cannot break on cross-directory module resolution.
import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'edgeone');

// EdgeOne has no portable equivalent of Workers KV for Node functions, so use a
// best-effort per-isolate in-memory cache. The core already swallows cache errors.
const ENTRY = `
import { respond } from './src/core.ts';

const store = new Map();
const enc = new TextEncoder();
const dec = new TextDecoder();

function toBytes(value) {
  if (typeof value === 'string') return enc.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new Error('Unsupported cache value');
}

const cache = {
  async get(key, type) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.exp !== Infinity && entry.exp <= Date.now()) { store.delete(key); return null; }
    if (type === 'arrayBuffer') return entry.bytes.slice().buffer;
    return dec.decode(entry.bytes);
  },
  async put(key, value, options) {
    const ttl = options && options.expirationTtl;
    store.set(key, { bytes: toBytes(value), exp: ttl ? Date.now() + ttl * 1000 : Infinity });
  },
};

export function onRequest(context) {
  const env = (context && context.env) || {};
  return respond(context.request, {
    GITHUB_TOKEN: env.GITHUB_TOKEN || env.GH_TOKEN || undefined,
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN || undefined,
    RPM_METADATA: cache,
  });
}
`;

const result = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'edgeone-entry.ts', loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
const bundle = result.outputFiles[0].text;
if (bundle.split('\n').some(line => /^\s*import\s/.test(line))) {
  throw new Error('Bundle still contains import statements; EdgeOne artifact would not be self-contained');
}
if (!/export\s+(async\s+)?function\s+onRequest|export\s*\{[^}]*onRequest/.test(bundle)) {
  throw new Error('Bundle is missing the onRequest export');
}

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'cloud-functions', 'repo'), { recursive: true });
await writeFile(path.join(OUT, 'cloud-functions', 'index.js'), bundle);
await writeFile(path.join(OUT, 'cloud-functions', 'repo', '[[default]].js'), bundle);

await writeFile(path.join(OUT, 'edgeone.json'), JSON.stringify({
  name: 'unified-repo',
  nodeVersion: '22.11.0',
  buildCommand: '',
  installCommand: '',
  outputDirectory: '.',
  cloudFunctions: { maxDuration: 120, regions: { overseas: ['ap-singapore'] } },
}, null, 2) + '\n');

await writeFile(path.join(OUT, 'package.json'), JSON.stringify({
  name: 'unified-repo-edgeone',
  private: true,
  type: 'module',
  engines: { node: '22' },
}, null, 2) + '\n');

console.log(`Built EdgeOne artifact: ${OUT} (${bundle.length} bytes per adapter)`);
