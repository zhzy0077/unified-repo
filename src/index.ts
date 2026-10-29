import { decompress } from 'fzstd';
import { sources } from './sources';

const encoder = new TextEncoder();
const xml = (s: unknown) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unxml = (s: string) => s.replace(/&quot;|&apos;|&lt;|&gt;|&amp;/g, c => ({'&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'}[c]!));
const digest = async (data: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');
const headers = { 'User-Agent': 'unified-fedora-repo', 'Accept': 'application/vnd.github+json' };
async function get(url: string, githubToken?: string): Promise<Response> {
  const authenticated = !!githubToken && new URL(url).origin === 'https://api.github.com';
  const requestHeaders = new Headers(headers);
  if (authenticated) requestHeaders.set('Authorization', `Bearer ${githubToken}`);
  const r = await fetch(url, { headers: requestHeaders, ...(authenticated ? { redirect: 'manual' as const } : {}) });
  if (!r.ok) {
    const responseHeaders = Object.fromEntries([...r.headers].filter(([name]) =>
      name.startsWith('x-ratelimit-') || ['retry-after', 'x-github-request-id'].includes(name)));
    let body = '';
    const reader = r.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let remaining = 4096;
      try {
        while (remaining > 0) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = value.subarray(0, remaining);
          body += decoder.decode(chunk, { stream: true });
          remaining -= chunk.length;
        }
        body += decoder.decode();
      } catch (error) {
        body += ` [Response body read failed: ${String(error)}]`;
      } finally { void reader.cancel().catch(() => {}); }
    }
    if (githubToken) body = body.replaceAll(githubToken, '[REDACTED]');
    console.error('Upstream request failed', { url, status: r.status, headers: responseHeaders, body });
    throw new Error(`Upstream returned ${r.status}: ${url}`);
  }
  return r;
}
function safePath(path: string): boolean { return !!path && !path.startsWith('/') && path.split('/').every(p => p !== '..' && p !== '.' && p !== '') && !path.includes('\\'); }
function assetPattern(source: (typeof sources.github)[number], release: string, arch: string) { return new RegExp(source.assetPattern.replaceAll('$releasever', release).replaceAll('$basearch', arch)); }
function repositoryBase(source: (typeof sources.repositories)[number], release: string, arch: string) {
  return source.baseUrl.replaceAll('$releasever', release).replaceAll('$basearch', arch);
}

// Read the RPM lead, signature header, and package header directly from the asset.
function rpmHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function header(offset: number) {
    if (offset + 16 > bytes.length || view.getUint32(offset) !== 0x8eade801) throw new Error('Invalid RPM header');
    const count = view.getUint32(offset + 8), size = view.getUint32(offset + 12), start = offset + 16 + count * 16;
    if (count > 100000 || start + size > bytes.length) throw new Error('Truncated RPM header');
    const tags = new Map<number, { type: number; offset: number; count: number }>();
    for (let i = 0; i < count; i++) { const p = offset + 16 + i * 16; tags.set(view.getUint32(p), {type:view.getUint32(p+4), offset:view.getUint32(p+8), count:view.getUint32(p+12)}); }
    function values(tag: number): (string | number)[] {
      const e = tags.get(tag); if (!e) return [];
      let p = start + e.offset; const end = start + size; const result: (string | number)[] = [];
      if (p < start || p > end || e.count > 1000000) throw new Error('Invalid RPM tag');
      if ([6, 8, 9].includes(e.type)) {
        for (let i = 0; i < (e.type === 6 ? 1 : e.count); i++) { let q = p; while (q < end && bytes[q] !== 0) q++; if (q === end) throw new Error('Invalid RPM string'); result.push(new TextDecoder().decode(bytes.subarray(p, q))); p = q + 1; }
      } else if ([1, 2, 3, 4, 5].includes(e.type)) {
        const width = e.type <= 2 ? 1 : e.type === 3 ? 2 : e.type === 4 ? 4 : 8;
        if (p + width * e.count > end) throw new Error('Invalid RPM values');
        for (let i = 0; i < e.count; i++, p += width) result.push(width === 1 ? view.getUint8(p) : width === 2 ? view.getUint16(p) : width === 4 ? view.getUint32(p) : Number(view.getBigUint64(p)));
      }
      return result;
    }
    return { values, end: start + size };
  }
  if (bytes.length < 96 || view.getUint32(0) !== 0xedabeedb) throw new Error('Invalid RPM lead');
  const sig = header(96); const main = header((sig.end + 7) & ~7);
  return { values: main.values, start: (sig.end + 7) & ~7, end: main.end };
}
function rpmPackage(bytes: Uint8Array, checksum: string, href: string, packageSize = bytes.length): string {
  const h = rpmHeader(bytes), v = h.values;
  const str = (tag: number) => String(v(tag)[0] ?? '');
  const num = (tag: number) => Number(v(tag)[0] ?? 0);
  const evr = (s: string) => { const m = /^(?:(\d+):)?([^-]*)(?:-(.*))?$/.exec(s); return m ? ` epoch="${xml(m[1] || '0')}" ver="${xml(m[2])}"${m[3] ? ` rel="${xml(m[3])}"` : ''}` : ''; };
  const deps = (kind: string, names: number, flags: number, versions: number) => {
    const n = v(names), f = v(flags), ver = v(versions); if (!n.length) return '';
    const entries = n.map((name, i) => { const flag = Number(f[i] ?? 0), sense = flag & 14; const op: Record<number,string> = {2:'LT',4:'GT',8:'EQ',10:'LE',12:'GE'}; return `<rpm:entry name="${xml(name)}"${op[sense] ? ` flags="${op[sense]}"${evr(String(ver[i] ?? ''))}` : ''}${kind === 'requires' && (flag & 64) ? ' pre="1"' : ''}/>`; }).join('');
    return `<rpm:${kind}>${entries}</rpm:${kind}>`;
  };
  return `<package type="rpm"><name>${xml(str(1000))}</name><arch>${xml(str(1022))}</arch><version epoch="${num(1003)}" ver="${xml(str(1001))}" rel="${xml(str(1002))}"/><checksum type="sha256" pkgid="YES">${checksum}</checksum><summary>${xml(str(1004))}</summary><description>${xml(str(1005))}</description><packager>${xml(str(1015))}</packager><url>${xml(str(1020))}</url><time file="${num(1006)}" build="${num(1006)}"/><size package="${packageSize}" installed="${num(1009)}" archive="${num(1046)}"/><location href="${xml(href)}"/><format><rpm:license>${xml(str(1014))}</rpm:license><rpm:vendor>${xml(str(1011))}</rpm:vendor><rpm:group>${xml(str(1016))}</rpm:group><rpm:buildhost>${xml(str(1007))}</rpm:buildhost><rpm:sourcerpm>${xml(str(1044))}</rpm:sourcerpm><rpm:header-range start="${h.start}" end="${h.end}"/>${deps('provides',1047,1112,1113)}${deps('requires',1049,1048,1050)}${deps('conflicts',1054,1053,1055)}${deps('obsoletes',1090,1114,1115)}${deps('recommends',5046,5048,5047)}${deps('suggests',5049,5051,5050)}${deps('supplements',5052,5054,5053)}${deps('enhances',5055,5057,5056)}</format></package>`;
}
type Asset = {name:string; browser_download_url:string; digest:string | null; size:number};

// Read only the lead and headers; the RPM payload is fetched by the client.
async function readRpmPrefix(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error('Missing RPM body');
  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  const limit = 8 * 1024 * 1024;
  async function requireBytes(n: number) {
    if (n > limit) throw new Error('RPM headers exceed size limit');
    while (buffer.length < n) {
      const {value, done} = await reader.read();
      if (done) throw new Error('Truncated RPM');
      if (buffer.length + value.length > limit + 1024 * 1024) throw new Error('RPM stream chunk exceeds size limit');
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer); next.set(value, buffer.length); buffer = next;
    }
  }
  async function headerEnd(offset: number) {
    await requireBytes(offset + 16);
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    if (view.getUint32(offset) !== 0x8eade801) throw new Error('Invalid RPM header');
    const count = view.getUint32(offset + 8), size = view.getUint32(offset + 12);
    if (count > 100000) throw new Error('RPM header index exceeds limit');
    const end = offset + 16 + count * 16 + size;
    await requireBytes(end);
    return end;
  }
  try {
    await requireBytes(96);
    if (new DataView(buffer.buffer, buffer.byteOffset).getUint32(0) !== 0xedabeedb) throw new Error('Invalid RPM lead');
    const end = await headerEnd(96);
    const mainEnd = await headerEnd(Math.ceil(end / 8) * 8);
    return buffer.slice(0, mainEnd);
  } finally { void reader.cancel(); }
}
async function repositoryPackages(source: (typeof sources.repositories)[number], release: string, arch: string): Promise<string[]> {
    const packages: string[] = [];
    const base = repositoryBase(source, release, arch);
    const repomd = await (await get(base + 'repodata/repomd.xml')).text();
    const primaryData = /<data\s+type="primary">([\s\S]*?)<\/data>/.exec(repomd)?.[1];
    const href = primaryData && /<location\s+href="([^"]+)"/.exec(primaryData)?.[1];
    if (!href || !safePath(unxml(href))) throw new Error(`Invalid primary metadata location for ${source.id}`);
    const response = await get(base + unxml(href));
    let sourceXml: string;
    if (href.endsWith('.zst')) {
      sourceXml = new TextDecoder().decode(decompress(new Uint8Array(await response.arrayBuffer())));
    } else if (href.endsWith('.gz')) {
      if (!response.body) throw new Error('Missing upstream metadata');
      sourceXml = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
    } else if (href.endsWith('.xml')) {
      sourceXml = await response.text();
    } else {
      throw new Error(`Unsupported primary metadata compression for ${source.id}`);
    }
    for (const match of sourceXml.matchAll(/<package\s+type="rpm">[\s\S]*?<\/package>/g)) {
      const pkg = match[0];
      const packageArch = /<arch>([^<]+)<\/arch>/.exec(pkg)?.[1];
      if (packageArch !== arch && packageArch !== 'noarch') continue;
      let rewritten = false;
      const result = pkg.replace(/<location\s+href="([^"]+)"\s*\/>/, (_whole, path: string) => {
        const decoded = unxml(path); if (!safePath(decoded)) throw new Error('Invalid package path');
        rewritten = true;
        return `<location href="packages/${source.id}/${xml(decoded)}"/>`;
      });
      if (!rewritten) throw new Error(`Invalid package location for ${source.id}`);
      packages.push(result);
    }
    return packages;
}
async function githubPackages(source: (typeof sources.github)[number], release: string, arch: string, env: Env): Promise<string[]> {
    const packages: string[] = [];
    const api = `https://api.github.com/repos/${source.repository}/releases/latest`;
    const releaseInfo = await (await get(api, env.GITHUB_TOKEN)).json() as { tag_name: string; assets: Asset[] };
    const pattern = assetPattern(source, release, arch);
    const selected = releaseInfo.assets.filter(a => pattern.test(a.name));
    for (const asset of selected) {
      const href = `packages/github/${source.id}/${encodeURIComponent(releaseInfo.tag_name)}/${encodeURIComponent(asset.name)}`;
      if (!asset.digest || !/^sha256:[0-9a-f]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('GitHub asset is missing a valid SHA-256 digest or size');
      // The cached record is independent of release URL, so identical assets can share it.
      const key = `rpm-primary-v1:${asset.digest.slice(7)}:${asset.size}`;
      let record: string | null = null;
      try { record = await env.RPM_METADATA.get(key); }
      catch (error) { console.error('KV metadata read failed', error); }
      if (record === null) {
        const prefix = await readRpmPrefix(await get(asset.browser_download_url));
        record = rpmPackage(prefix, asset.digest.slice(7), '__RPM_LOCATION__', asset.size);
        try { await env.RPM_METADATA.put(key, record, {expirationTtl: 30 * 24 * 60 * 60}); }
        catch (error) { console.error('KV metadata write failed', error); }
      }
      packages.push(record.replace('href="__RPM_LOCATION__"', `href="${xml(href)}"`));
    }
    return packages;
}

// Keep at most four upstream operations active while preserving configured order.
async function primary(release: string, arch: string, env: Env): Promise<Uint8Array> {
  const cacheKey = `repo-primary-v1:${release}:${arch}`;
  try {
    const cached = await env.RPM_METADATA.get(cacheKey, 'arrayBuffer');
    if (cached !== null) return new Uint8Array(cached);
  } catch (error) { console.error('KV repository snapshot read failed', error); }
  const jobs: Array<() => Promise<string[]>> = [
    ...sources.repositories.map(source => () => repositoryPackages(source, release, arch)),
    ...sources.github.map(source => () => githubPackages(source, release, arch, env)),
  ];
  const results: string[][] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, jobs.length)}, async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
    }
  }));
  const packages = results.flat();
  const data = encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="${packages.length}">${packages.join('')}</metadata>`);
  try { await env.RPM_METADATA.put(cacheKey, data as Uint8Array<ArrayBuffer>, { expirationTtl: 60 * 60 }); }
  catch (error) { console.error('KV repository snapshot write failed', error); }
  return data;
}
async function handle(request: Request, env: Env): Promise<Response> {
  if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  if (url.pathname === '/') {
    return new Response(`Unified Fedora RPM repository

To enable it, run:

sudo dnf config-manager addrepo --id=unified --set='baseurl=https://repo.zhzy.workers.dev/repo/$releasever/$basearch/' --set=gpgcheck=0

Then run: sudo dnf makecache

gpgcheck=0 disables RPM signature verification for this repository.
`, {headers: {'Content-Type': 'text/plain; charset=utf-8'}});
  }
  const match = /^\/repo\/(\d+)\/(x86_64|aarch64)\/(.*)$/.exec(url.pathname);
  if (!match) return new Response('Not found', {status:404});
  const [, release, arch, path] = match;
  if (path === 'repodata/repomd.xml' || /^repodata\/[0-9a-f]{64}-primary\.xml$/.test(path)) {
    const data = await primary(release, arch, env), hash = await digest(data);
    if (path !== 'repodata/repomd.xml') return path === `repodata/${hash}-primary.xml` ? new Response(data as Uint8Array<ArrayBuffer>, {headers:{'Content-Type':'application/xml','Cache-Control':'no-store'}}) : new Response('Repository snapshot changed; refresh metadata', {status:404});
    const body = `<?xml version="1.0" encoding="UTF-8"?><repomd xmlns="http://linux.duke.edu/metadata/repo"><revision>${hash}</revision><data type="primary"><checksum type="sha256">${hash}</checksum><location href="repodata/${hash}-primary.xml"/><timestamp>0</timestamp><size>${data.length}</size></data></repomd>`;
    return new Response(body, {headers:{'Content-Type':'application/xml','Cache-Control':'no-store'}});
  }
  const repoPackage = /^packages\/([^/]+)\/(.+)$/.exec(path);
  if (repoPackage && repoPackage[1] !== 'github') {
    const source = sources.repositories.find(item => item.id === repoPackage[1]);
    if (!source) return new Response('Unknown repository', {status:404});
    const relative = decodeURIComponent(repoPackage[2]); if (!safePath(relative)) return new Response('Invalid path', {status:400});
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    return Response.redirect(repositoryBase(source, release, arch) + encoded, 302);
  }
  // Keep the original Deskflow paths working for clients with cached metadata.
  const gh = /^packages\/github\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  const legacyGh = /^packages\/github\/([^/]+)\/([^/]+)$/.exec(path);
  if (gh || legacyGh) {
    const sourceId = gh ? gh[1] : 'deskflow';
    const source = sources.github.find(item => item.id === sourceId);
    if (!source) return new Response('Unknown repository', {status:404});
    const tag = decodeURIComponent(gh ? gh[2] : legacyGh![1]);
    const name = decodeURIComponent(gh ? gh[3] : legacyGh![2]);
    if (!/^[\w.-]+$/.test(tag) || !assetPattern(source, release, arch).test(name)) return new Response('Invalid asset', {status:400});
    const target = `https://github.com/${source.repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    return Response.redirect(target, 302);
  }
  return new Response('Not found', {status:404});
}
export default { async fetch(request: Request, env: Env): Promise<Response> { try { return await handle(request, env); } catch (error) { console.error(error); return new Response('Upstream repository error', {status:502}); } } } satisfies ExportedHandler<Env>;
