import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fixShebang, readRuntimeDeps } from "./lib/pi-common.mjs";

const SCOPE_OLD = "@earendil-works";
const SCOPE_NEW = process.argv.includes("--scope")
  ? process.argv[process.argv.indexOf("--scope") + 1]
  : "@jishu-hub";

const DRY_RUN = process.argv.includes("--dry-run");

let otpArg = "";
const otpMatch = process.argv.find(arg => arg.startsWith("--otp="));
if (otpMatch) {
  otpArg = otpMatch;
}

const ROOT_DIR = path.resolve(process.cwd(), "third_party", "pi");
const PACKAGES_DIR = path.join(ROOT_DIR, "packages");

if (!fs.existsSync(PACKAGES_DIR)) {
  console.error("Packages directory not found at:", PACKAGES_DIR);
  process.exit(1);
}

const packages = fs.readdirSync(PACKAGES_DIR).filter(p => {
  return fs.statSync(path.join(PACKAGES_DIR, p)).isDirectory();
});

console.log(`Starting Pi Publisher (NPM Alias Pipeline)...`);
console.log(`Old Scope: ${SCOPE_OLD}`);
console.log(`New Scope: ${SCOPE_NEW}`);
if (DRY_RUN) console.log(`[DRY RUN MODE] Files will be written, but npm publish will not be executed.`);

console.log(`\nRestoring dev dependencies for clean build...`);
execSync("npm install", { cwd: ROOT_DIR, stdio: "inherit" });

console.log(`\nBuilding packages normally (using original source code)...`);
execSync("npm run build", { cwd: ROOT_DIR, stdio: "inherit" });

const nameMapping = {
  "coding-agent": `${SCOPE_NEW}/jishu-agent`,
  "ai": `${SCOPE_NEW}/jishu-agent-ai`,
  "agent": `${SCOPE_NEW}/jishu-agent-core`,
  "tui": `${SCOPE_NEW}/jishu-agent-tui`,
  // v0.81.0 上游把 orchestrator 包重命名为 server（npm 名 @earendil-works/pi-server），
  // 但我们对外发布的 npm 包名仍保持 jishu-agent-orchestrator 以维持已发布版本名的连续性。
  "server": `${SCOPE_NEW}/jishu-agent-orchestrator`,
};

// Retrieve the current version to use in the alias strings
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
const version = rootPkg.version;
console.log(`Workspace Version: ${version}`);

const replaceDepWithAlias = (dep) => {
  if (dep === "@earendil-works/pi-coding-agent") return `npm:${nameMapping["coding-agent"]}@${version}`;
  if (dep === "@earendil-works/pi-ai") return `npm:${nameMapping["ai"]}@${version}`;
  if (dep === "@earendil-works/pi-agent-core") return `npm:${nameMapping["agent"]}@${version}`;
  if (dep === "@earendil-works/pi-tui") return `npm:${nameMapping["tui"]}@${version}`;
  if (dep === "@earendil-works/pi-server") return `npm:${nameMapping["server"]}@${version}`;
  return null;
};

const publishOrder = ["tui", "ai", "agent", "coding-agent", "server"];
let packagesToPublish = packages.sort((a, b) => {
  const idxA = publishOrder.indexOf(a) === -1 ? 99 : publishOrder.indexOf(a);
  const idxB = publishOrder.indexOf(b) === -1 ? 99 : publishOrder.indexOf(b);
  return idxA - idxB;
});

const onlyMatch = process.argv.find(arg => arg.startsWith("--only="));
if (onlyMatch) {
  const onlyPkg = onlyMatch.split("=")[1];
  packagesToPublish = packagesToPublish.filter(p => p === onlyPkg);
}

console.log(`\nPublishing packages in order: ${packagesToPublish.join(" -> ")}\n`);

for (const pkg of packagesToPublish) {
  const pkgDir = path.join(PACKAGES_DIR, pkg);
  if (!fs.existsSync(path.join(pkgDir, "package.json"))) continue;
  if (!nameMapping[pkg]) continue;

  console.log(`\n=============================================`);
  console.log(`Staging for Publish: ${pkg}`);
  console.log(`=============================================`);

  const stageDir = path.join(pkgDir, ".publish-stage");
  if (fs.existsSync(stageDir)) {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stageDir, { recursive: true });

  // Copy all files required for publish, including dist/ and bin/ if present
  const filesToCopy = ["dist", "bin", "package.json", "README.md", "npm-shrinkwrap.json"];
  for (const f of filesToCopy) {
    const srcPath = path.join(pkgDir, f);
    const destPath = path.join(stageDir, f);
    if (fs.existsSync(srcPath)) {
      if (fs.statSync(srcPath).isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // Edit package.json in stage directory
  const stagePkgJsonPath = path.join(stageDir, "package.json");
  const json = JSON.parse(fs.readFileSync(stagePkgJsonPath, "utf-8"));
  json.name = nameMapping[pkg];
  
  for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (json[depType]) {
      for (const [dep, ver] of Object.entries(json[depType])) {
        const alias = replaceDepWithAlias(dep);
        if (alias) {
          json[depType][dep] = alias; // Keep the original key, just change the value to an NPM alias!
        }
      }
    }
  }

  // coding-agent is the esbuild entry point. build-bundle.mjs emits
  // dist/runtime-deps.json listing exactly the non-@earendil-works dependencies
  // it externalized. The published package.json must declare all of them —
  // otherwise runtime `import "openai"` fails with ERR_MODULE_NOT_FOUND. Reading
  // the manifest (rather than re-deriving the set here) keeps Lite's declared
  // deps identical to what esbuild left unresolved AND to what pack-pi.mjs
  // (Full) installs: one source of truth, no drift between the two paths.
  if (pkg === "coding-agent") {
    if (!json.dependencies) json.dependencies = {};
    const runtimeDeps = readRuntimeDeps(path.join(PACKAGES_DIR, "coding-agent", "dist"));
    for (const [dep, ver] of Object.entries(runtimeDeps)) {
      if (!(dep in json.dependencies)) {
        json.dependencies[dep] = ver;
      }
    }
  }

  // Remove lifecycle scripts that would fail inside the staging directory
  if (json.scripts) {
    delete json.scripts.prepublishOnly;
    delete json.scripts.prepublish;
    delete json.scripts.prepare;
    delete json.scripts.prepack;
  }

  fs.writeFileSync(stagePkgJsonPath, JSON.stringify(json, null, "\t") + "\n");

  // Transform npm-shrinkwrap.json for the alias publish. (Lite/npm path only —
  // Full via pack-pi.mjs installs from the workspace and never touches this.)
  //
  // The published package.json keeps the @earendil-works/* import KEYS and only
  // rewrites their VALUES to npm aliases (npm:@jishu-hub/...@version). npm
  // therefore installs each internal package at node_modules/@earendil-works/pi-X,
  // so the shrinkwrap package KEYS must stay @earendil-works/* — they are the
  // install locations, and renaming them breaks resolution (every aliased dep
  // then 404s, the Lite crash this fixes).
  //
  // The ONLY field that must change is `resolved`: generate-coding-agent-shrinkwrap.mjs
  // points internal packages at the @earendil-works/* tarball, which the fork
  // never publishes. Repoint it at the @jishu-hub/* tarball the alias resolves to.
  // Everything else — keys, integrity, the curated/allowlisted external tree — is
  // inherited verbatim, preserving upstream's supply-chain hardening.
  const stageShrinkwrapPath = path.join(stageDir, "npm-shrinkwrap.json");
  if (fs.existsSync(stageShrinkwrapPath)) {
    const shrinkwrap = JSON.parse(fs.readFileSync(stageShrinkwrapPath, "utf-8"));

    // @earendil-works npm name → @jishu-hub npm name. Must mirror replaceDepWithAlias.
    const earendilToJishu = {
      "@earendil-works/pi-coding-agent": `${SCOPE_NEW}/jishu-agent`,
      "@earendil-works/pi-ai": `${SCOPE_NEW}/jishu-agent-ai`,
      "@earendil-works/pi-agent-core": `${SCOPE_NEW}/jishu-agent-core`,
      "@earendil-works/pi-tui": `${SCOPE_NEW}/jishu-agent-tui`,
      "@earendil-works/pi-server": `${SCOPE_NEW}/jishu-agent-orchestrator`,
    };
    const tarballUrl = (jishuName, ver) => {
      const slug = jishuName.split("/")[1];
      return `https://registry.npmjs.org/${jishuName}/-/${slug}-${ver}.tgz`;
    };

    // Top-level name mirrors the published package name.
    if (shrinkwrap.name && earendilToJishu[shrinkwrap.name]) {
      shrinkwrap.name = earendilToJishu[shrinkwrap.name];
    }

    if (shrinkwrap.packages) {
      for (const [key, entry] of Object.entries(shrinkwrap.packages)) {
        if (key === "") {
          // Root entry: align its name with the published package name.
          if (entry.name && earendilToJishu[entry.name]) {
            entry.name = earendilToJishu[entry.name];
          }
          continue;
        }
        const jishuName = earendilToJishu[key.replace(/^node_modules\//, "")];
        if (jishuName && entry.version) {
          entry.resolved = tarballUrl(jishuName, entry.version);
        }
      }
      // Guard: keys must stay @earendil-works/* (the alias install locations).
      // A @jishu-hub key here means the old rename bug regressed — fail loudly
      // rather than shipping a broken shrinkwrap that 404s on install.
      const renamed = Object.keys(shrinkwrap.packages).filter(k => k.includes("@jishu-hub"));
      if (renamed.length > 0) {
        throw new Error(`Shrinkwrap keys must not be renamed to @jishu-hub/* (found: ${renamed.join(", ")}).`);
      }
    }

    fs.writeFileSync(stageShrinkwrapPath, JSON.stringify(shrinkwrap, null, "\t") + "\n");
    console.log(`Rewrote internal-package resolved URLs in npm-shrinkwrap.json (keys preserved, curated tree inherited).`);
  }

  // Fix double shebang in entry points (shared implementation with pack-pi.mjs)
  fixShebang(path.join(stageDir, "dist"));

  console.log(`Configured NPM aliases in package.json (no code modified!).`);

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would run: npm publish --access public --registry=https://registry.npmjs.org/ --tag latest ${otpArg} inside ${stageDir}`);
  } else {
    try {
      execSync(`npm publish --access public --registry=https://registry.npmjs.org/ --tag latest ${otpArg}`, { cwd: stageDir, stdio: "inherit" });
      console.log(`✅ Successfully published ${pkg}`);
    } catch (err) {
      console.error(`❌ Failed to publish ${pkg}`);
      process.exit(1);
    }
  }
}

console.log("\nAll done!");
