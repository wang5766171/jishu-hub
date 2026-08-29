import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read dependencies from all runtime packages. Internal @earendil-works packages
// are bundled; third-party packages are emitted into runtime-deps.json.
// Note: v0.81.0 renamed the `orchestrator` package to `server`.
const packages = ['coding-agent', 'agent', 'ai', 'tui', 'server', 'client', 'protocol'];

// Collect the runtime dependency set (name -> version) that esbuild must leave
// external. This map is the single source of truth shared by Full (pack-pi.mjs)
// and Lite (publish-pi.mjs) packaging — it is emitted as dist/runtime-deps.json
// after the build so the two packaging paths can never drift on which deps the
// bundled cli.js needs at runtime.
const runtimeDeps = {};

// Pick the higher of two (possibly range-prefixed) semver strings. Deps are
// pinned in these package.jsons, but the same dep may appear in more than one
// package; npm resolves such conflicts to the highest, so we mirror that here.
const higherVersion = (a, b) => {
  const pa = a.replace(/^[^0-9]+/, '').split('.').map(Number);
  const pb = b.replace(/^[^0-9]+/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? a : b;
  }
  return a;
};

for (const pkgName of packages) {
  const pkgPath = join(__dirname, '..', pkgName, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.dependencies) continue;
  for (const [dep, ver] of Object.entries(pkg.dependencies)) {
    if (dep.startsWith('@earendil-works/')) continue; // bundled into cli.js, not external
    const existing = runtimeDeps[dep];
    runtimeDeps[dep] = existing ? higherVersion(existing, ver) : ver;
  }
}

const external = Object.keys(runtimeDeps);

console.log('Externalizing the following dependencies:', external);

await esbuild.build({
  entryPoints: ['src/cli.ts', 'src/index.ts', 'src/rpc-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  minify: true,
  outdir: 'dist',
  external,
  format: 'esm',
  define: {
    'process.env.ESBUILD_BUNDLED': '"true"',
  },
  plugins: [],
});

// Emit the runtime dependency manifest consumed by pack-pi.mjs (Full) and
// publish-pi.mjs (Lite). Deriving it from the same `external` set esbuild just
// used guarantees that what the bundler leaves unresolved is exactly what the
// packaging scripts declare (Lite) / install (Full) — no drift is possible.
writeFileSync(join(__dirname, 'dist', 'runtime-deps.json'), JSON.stringify(runtimeDeps, null, 2) + '\n');
console.log(`Wrote dist/runtime-deps.json (${external.length} runtime dependencies).`);

console.log('Build completed!');
