import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const bump = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(bump)) {
  console.error(`Usage: bun run release [patch|minor|major]`);
  process.exit(1);
}

const TAURI_CONF = "src-tauri/tauri.conf.json";
const PKG = "package.json";
const CARGO = "src-tauri/Cargo.toml";

execSync("git fetch origin", { stdio: "inherit" });
execSync("git rebase --autostash origin/main", { stdio: "inherit" });

const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
const [maj, min, pat] = conf.version.split(".").map(Number);

const next =
  bump === "major" ? `${maj + 1}.0.0` :
  bump === "minor" ? `${maj}.${min + 1}.0` :
                     `${maj}.${min}.${pat + 1}`;

conf.version = next;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + "\n");

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
pkg.version = next;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

let cargo = readFileSync(CARGO, "utf8");
cargo = cargo.replace(/^version = ".*?"/m, `version = "${next}"`);
writeFileSync(CARGO, cargo);

try {
  execSync("cargo check", { cwd: "src-tauri", stdio: "inherit" });
} catch (e) {
  console.warn("Could not run cargo check to update Cargo.lock:", e.message);
}

console.log(`Releasing v${next}…`);
execSync(`git add ${TAURI_CONF} ${PKG} ${CARGO} src-tauri/Cargo.lock`, { stdio: "inherit" });
execSync(`git commit -m "chore: release v${next}"`, { stdio: "inherit" });
execSync(`git tag -a v${next} -m "Release v${next}"`, { stdio: "inherit" });
execSync(`git push origin main v${next}`, { stdio: "inherit" });
console.log(`Done — v${next} tagged and pushed. CI will build and draft the release.`);