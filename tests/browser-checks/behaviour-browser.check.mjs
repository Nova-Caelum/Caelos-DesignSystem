import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const fixture = path.join(root, "tests", "fixtures", "behaviour-app");
const runner = path.join(root, "scripts", "behaviour-check", "run-behaviours.mjs");

const passLine = {
  id: "browser-pass",
  kind: "action",
  handler: "handlePass",
  steps: [
    { do: "click", role: "button", name: "Pass action" },
    { do: "expect", role: "status", name: "Passed", expect: "visible" },
  ],
};

const failLine = {
  id: "browser-fails-twice",
  kind: "state",
  handler: null,
  steps: [{ do: "expect", role: "status", name: "Never appears", expect: "visible" }],
};

const flakyLine = {
  id: "browser-fail-then-pass",
  kind: "action",
  handler: "handleFlaky",
  steps: [
    { do: "click", role: "button", name: "Flaky action" },
    { do: "expect", role: "status", name: "Ready after retry", expect: "visible" },
  ],
};

async function runBrowserCase(name, lines) {
  const folder = await mkdtemp(path.join(tmpdir(), `behaviour-browser-${name}-`));
  const behaviours = path.join(folder, "behaviours");
  await mkdir(behaviours);
  await writeFile(
    path.join(behaviours, `${name}.behaviours.json`),
    `${JSON.stringify({ screen: "PrimaryScreen.jsx", lines }, null, 2)}\n`,
  );
  const out = path.join(folder, "results.json");
  const unsteady = path.join(folder, "unsteady-lines.json");
  const result = spawnSync(
    process.execPath,
    [runner, "--app", fixture, "--behaviours", behaviours, "--out", out, "--unsteady", unsteady],
    { encoding: "utf8", timeout: 60_000 },
  );
  return {
    result,
    results: JSON.parse(await readFile(out, "utf8")),
    unsteady: JSON.parse(await readFile(unsteady, "utf8")),
  };
}

test("browser (a) every line passes end to end", async () => {
  const run = await runBrowserCase("pass", [passLine]);
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.equal(run.results.summary.failed, 0);
  assert.equal(run.unsteady.lines.length, 0);
});

test("browser (b) a line failing twice exits 1 and names its id and step", async () => {
  const run = await runBrowserCase("fail", [failLine]);
  assert.equal(run.result.status, 1, `${run.result.stdout}\n${run.result.stderr}`);
  assert.match(run.result.stdout, /browser-fails-twice/);
  assert.match(run.result.stdout, /step 1/);
  assert.equal(run.results.summary.failed, 1);
});

test("browser (c) a line failing then passing is recorded as unsteady", async () => {
  const run = await runBrowserCase("unsteady", [flakyLine]);
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.deepEqual(run.unsteady.lines.map((line) => line.id), ["browser-fail-then-pass"]);
});
