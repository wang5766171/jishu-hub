import fs from "fs";
import path from "path";
import { execSync } from "child_process";

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
  "tui": `${SCOPE_NEW}/jishu-agent-tui`
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
  return null;
};

const publishOrder = ["tui", "ai", "agent", "coding-agent"];
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

  // Remove lifecycle scripts that would fail inside the staging directory
  if (json.scripts) {
    delete json.scripts.prepublishOnly;
    delete json.scripts.prepublish;
    delete json.scripts.prepare;
    delete json.scripts.prepack;
  }

  fs.writeFileSync(stagePkgJsonPath, JSON.stringify(json, null, "\t") + "\n");

  // Transform npm-shrinkwrap.json: replace @earendil-works/* references with @jishu-hub/* equivalents
  const stageShrinkwrapPath = path.join(stageDir, "npm-shrinkwrap.json");
  if (fs.existsSync(stageShrinkwrapPath)) {
    const shrinkwrap = JSON.parse(fs.readFileSync(stageShrinkwrapPath, "utf-8"));
    const oldPrefix = "@earendil-works/pi-";
    const shrinkwrapNameMapping = {
      "coding-agent": `${SCOPE_NEW}/jishu-agent`,
      "ai": `${SCOPE_NEW}/jishu-agent-ai`,
      "agent": `${SCOPE_NEW}/jishu-agent-core`,
      "tui": `${SCOPE_NEW}/jishu-agent-tui`,
    };

    if (shrinkwrap.name && shrinkwrap.name.startsWith(oldPrefix)) {
      const shortName = shrinkwrap.name.slice(oldPrefix.length);
      if (shrinkwrapNameMapping[shortName]) {
        shrinkwrap.name = shrinkwrapNameMapping[shortName];
      }
    }

    if (shrinkwrap.packages) {
      const keysToRename = [];
      for (const key of Object.keys(shrinkwrap.packages)) {
        if (key === "") continue; // root package handled separately
        for (const [oldShort, newName] of Object.entries(shrinkwrapNameMapping)) {
          const oldNodeModulesKey = `node_modules/${SCOPE_OLD.slice(1)}/pi-${oldShort}`;
          if (key === oldNodeModulesKey) {
            keysToRename.push({ oldKey: key, newKey: `node_modules/${newName}`, newName });
          }
        }
      }
      for (const { oldKey, newKey, newName } of keysToRename) {
        const entry = shrinkwrap.packages[oldKey];
        // Update the resolved URL to point to the new package name on npmjs.org
        if (entry.resolved) {
          entry.resolved = entry.resolved.replace(
            /registry\.npmjs\.org\/@earendil-works\/pi-[^/]+\//,
            `registry.npmjs.org/${newName}/-/${newName.split('/')[1]}-`
          );
          // Rebuild the resolved URL properly: https://registry.npmjs.org/@scope/name/-/name-version.tgz
          const v = entry.version;
          const nameSlug = newName.split('/')[1];
          entry.resolved = `https://registry.npmjs.org/${newName}/-/${nameSlug}-${v}.tgz`;
        }
        delete shrinkwrap.packages[oldKey];
        shrinkwrap.packages[newKey] = entry;
      }
    }

    // Replace all @earendil-works/pi-* string occurrences in the shrinkwrap with @jishu-hub/* equivalents
    let shrinkwrapStr = JSON.stringify(shrinkwrap, null, "\t");
    for (const [oldShort, newName] of Object.entries(shrinkwrapNameMapping)) {
      const oldFullName = `${SCOPE_OLD}/pi-${oldShort}`;
      shrinkwrapStr = shrinkwrapStr.split(oldFullName).join(newName);
    }
    fs.writeFileSync(stageShrinkwrapPath, shrinkwrapStr + "\n");
    console.log(`Transformed npm-shrinkwrap.json aliases.`);
  }

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
