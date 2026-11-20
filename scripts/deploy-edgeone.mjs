// Deploy the built EdgeOne artifact to the unified-repo project.
// Secrets are read from the gitignored .env and are never printed or passed as argv.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'edgeone');
const PROJECT_ID = 'makers-e3rpba6wqg6p';
const API = 'https://pages-api.cloud.tencent.com/v1';

function loadEnv() {
  const text = readFileSync(path.join(ROOT, '.env'), 'utf8');
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const edToken = vars.EDGEONE_PAGES_API_TOKEN;
  const ghToken = vars.GH_TOKEN;
  if (!edToken) throw new Error('EDGEONE_PAGES_API_TOKEN missing in .env');
  if (!ghToken) throw new Error('GH_TOKEN missing in .env (needed as the EdgeOne GITHUB_TOKEN env var)');
  return { edToken, ghToken };
}

async function api(payload, edToken) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${edToken}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Invalid EdgeOne API response: ${text.slice(0, 200)}`); }
  const r = json?.Data?.Response ?? json;
  const code = json?.Code ?? r?.Code;
  if (!res.ok || (code !== undefined && code !== 0)) {
    throw new Error(`EdgeOne API ${payload.Action} failed: ${code ?? res.status} ${r?.Message ?? json?.Message ?? text.slice(0, 200)}`);
  }
  return r;
}

async function projectOrigin(edToken) {
  // EdgeOne rewrites request.url to an internal SCF host, so advertise the
  // project's bound public domain instead of deriving it from the request.
  const r = await api({ Action: 'DescribePagesProjects', ProjectIds: [PROJECT_ID], Limit: 1, Offset: 0 }, edToken);
  const p = (r?.Projects ?? [])[0] ?? {};
  const custom = (p.CustomDomains ?? [])[0]?.Domain;
  if (custom) return `https://${custom}`;
  return p.PresetDomain ? `https://${p.PresetDomain}` : undefined;
}

async function setProjectEnvs(vars, edToken) {
  // Reuse existing entries' Ids so re-deploys update instead of duplicating.
  const described = await api({ Action: 'DescribePagesProjectEnvs', ProjectId: PROJECT_ID }, edToken);
  const ids = new Map((described?.EnvVars ?? []).map(v => [v.Key, v.Id]));
  const envVars = vars.map(({ Key, Value }) => {
    const entry = { Key, Value, Env: ['Production'] };
    if (ids.get(Key)) entry.Id = ids.get(Key);
    return entry;
  });
  await api({ Action: 'ModifyPagesProjectEnvs', ProjectId: PROJECT_ID, EnvVars: envVars }, edToken);
  console.log(`Set project env vars (Production): ${vars.map(v => v.Key).join(', ')}`);
}

const { edToken, ghToken } = loadEnv();
if (!existsSync(path.join(DIST, 'edgeone.json'))) {
  throw new Error('Missing built artifact; run: npm run build:edgeone');
}
const vars = [{ Key: 'GITHUB_TOKEN', Value: ghToken }];
const publicOrigin = await projectOrigin(edToken);
if (publicOrigin) vars.push({ Key: 'PUBLIC_ORIGIN', Value: publicOrigin });
await setProjectEnvs(vars, edToken);

const localBin = path.join(ROOT, 'node_modules', '.bin', 'edgeone');
const useLocal = existsSync(localBin);
const exe = useLocal ? localBin : 'npx';
const prefix = useLocal ? [] : ['--yes', 'edgeone@1.7.5'];
const args = [
  ...prefix,
  'makers', 'deploy', '.',
  '-n', 'unified-repo',
  '-e', 'production',
  '-a', 'overseas',
  '--json',
  '--skip-ai-gateway-sync',
];

console.log(`Deploying to EdgeOne project ${PROJECT_ID} ...`);
const r = spawnSync(exe, args, {
  cwd: DIST,
  env: { ...process.env, EDGEONE_PAGES_API_TOKEN: edToken },
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'inherit'],
  timeout: 10 * 60 * 1000,
});
if (r.error) throw r.error;
process.stdout.write(r.stdout ?? '');
if (r.status !== 0) throw new Error(`edgeone deploy exited with ${r.status}`);

const jsonLine = [...(r.stdout ?? '').split(/\r?\n/)].reverse().find(l => l.trim().startsWith('{'));
let out = {};
try { out = jsonLine ? JSON.parse(jsonLine) : {}; } catch {}
const reportedId = out.projectId ?? out.project_id ?? out.ProjectId;
if (reportedId && reportedId !== PROJECT_ID) {
  throw new Error(`Refusing to continue: deploy reported unexpected projectId ${reportedId}`);
}
const url = out.url ?? out.deployUrl ?? out.accessUrl ?? out.EDGEONE_DEPLOY_URL;
console.log('Deploy succeeded.', url ? `Access URL: ${url}` : 'See --json output above for the access URL.');
