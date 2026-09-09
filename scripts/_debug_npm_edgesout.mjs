import { execSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ENDPOINT =
  "http://127.0.0.1:7701/ingest/f10665cb-cfa8-4da3-8264-84e4af6042a7";
const SESSION = "3831ee";

function agentLog(hypothesisId, location, message, data) {
  // #region agent log
  fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": SESSION,
    },
    body: JSON.stringify({
      sessionId: SESSION,
      runId: "pre-fix",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

function latestNpmLog() {
  const dir = path.join(homedir(), ".npm/_logs");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith("-debug-0.log"))
    .map((f) => {
      const p = path.join(dir, f);
      return { p, m: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.m - a.m);
  return files[0]?.p ?? null;
}

const nodeV = process.version;
const npmV = execSync("npm -v", { encoding: "utf8" }).trim();
const whichNode = execSync("which node", { encoding: "utf8" }).trim();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

agentLog("A", "scripts/_debug_npm_edgesout.mjs:node", "runtime versions", {
  nodeV,
  npmV,
  whichNode,
  nodeMajor: Number(nodeV.slice(1).split(".")[0]),
});

agentLog("B", "scripts/_debug_npm_edgesout.mjs:pkg", "vitest pin state", {
  hasVitest: Boolean(pkg.devDependencies?.vitest || pkg.dependencies?.vitest),
  vitestRange:
    pkg.devDependencies?.vitest || pkg.dependencies?.vitest || null,
  scriptsTest: pkg.scripts?.test ?? null,
});

const result = spawnSync("npm", ["install", "vitest", "-D"], {
  encoding: "utf8",
  env: process.env,
});

const logPath = latestNpmLog();
let stackSnippet = "";
let fetchManifests = [];
let npmFromLog = null;
let nodeFromLog = null;
if (logPath) {
  const text = readFileSync(logPath, "utf8");
  const stackLines = text
    .split("\n")
    .filter((l) => l.includes("verbose stack") || l.includes("error Cannot"));
  stackSnippet = stackLines.slice(0, 8).join("\n");
  fetchManifests = text
    .split("\n")
    .filter((l) => l.includes("fetch manifest"))
    .slice(0, 25);
  const npmMatch = text.match(/verbose npm\s+v([^\s]+)/);
  const nodeMatch = text.match(/verbose node (v[^\s]+)/);
  npmFromLog = npmMatch?.[1] ?? null;
  nodeFromLog = nodeMatch?.[1] ?? null;
}

agentLog("C", "scripts/_debug_npm_edgesout.mjs:install", "npm install result", {
  status: result.status,
  stderrTail: (result.stderr || "").split("\n").slice(-8),
  crashedEdgesOut: /edgesOut/.test(result.stderr || ""),
  logPath,
  nodeFromLog,
  npmFromLog,
});

agentLog("D", "scripts/_debug_npm_edgesout.mjs:peers", "peer graph probes", {
  sawVitest5: fetchManifests.some((l) => /vitest@5/.test(l)),
  sawBetaPeer: fetchManifests.some((l) => /5\.0\.0-beta/.test(l)),
  sawBrowserPlaywright: fetchManifests.some((l) =>
    l.includes("@vitest/browser-playwright")
  ),
  fetchManifests,
  stackSnippet,
});

agentLog("E", "scripts/_debug_npm_edgesout.mjs:lock", "lockfile presence", {
  lockExists: true,
  lockfileVersion: JSON.parse(readFileSync("package-lock.json", "utf8"))
    .lockfileVersion,
});

console.log(
  JSON.stringify(
    { status: result.status, crashedEdgesOut: /edgesOut/.test(result.stderr || ""), nodeV, npmV },
    null,
    2
  )
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
