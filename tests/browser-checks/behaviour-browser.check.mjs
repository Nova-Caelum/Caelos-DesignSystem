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

const passScreen = "export function S(){ const handlePass=()=>{}; return <button onClick={handlePass}>Pass action</button>; }\n";
const emptyScreen = "export function S(){ return <main />; }\n";
const flakyScreen = "export function S(){ const handleFlaky=()=>{}; return <button onClick={handleFlaky}>Flaky action</button>; }\n";
const saveScreen = "export function S(){ const handleSave=()=>{}; return <button onClick={handleSave}>Save draft</button>; }\n";

async function readJsonIfWritten(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function runBrowserCase(name, lines, screenSource, { route = "/" } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), `behaviour-browser-${name}-`));
  const behaviours = path.join(folder, "behaviours");
  await mkdir(behaviours);
  await writeFile(path.join(folder, "Screen.jsx"), screenSource);
  await writeFile(
    path.join(behaviours, `${name}.behaviours.json`),
    `${JSON.stringify({ screen: "../Screen.jsx", route, lines }, null, 2)}\n`,
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
    results: await readJsonIfWritten(out),
    unsteady: await readJsonIfWritten(unsteady),
  };
}

test("W1: every line passes end to end", async () => {
  const run = await runBrowserCase("pass", [passLine], passScreen);
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.equal(run.results.summary.failed, 0);
  assert.equal(run.unsteady.lines.length, 0);
});

test("W2: a line failing twice exits 1 and names its id and step", async () => {
  const run = await runBrowserCase("fail", [failLine], emptyScreen);
  assert.equal(run.result.status, 1, `${run.result.stdout}\n${run.result.stderr}`);
  assert.match(run.result.stdout, /browser-fails-twice/);
  assert.match(run.result.stdout, /step 1/);
  assert.equal(run.results.summary.failed, 1);
});

test("W3: a line failing then passing is recorded as unsteady", async () => {
  const run = await runBrowserCase("unsteady", [flakyLine], flakyScreen);
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.deepEqual(run.unsteady.lines.map((line) => line.id), ["browser-fail-then-pass"]);
});

test("W4: browser storage is fresh per line but retained for a retry", async () => {
  const lines = [
    {
      id: "first-flaky-line",
      kind: "action",
      handler: "handleFlaky",
      steps: [
        { do: "click", role: "button", name: "Flaky action" },
        { do: "expect", role: "status", name: "Not ready yet", expect: "visible" },
      ],
    },
    { ...flakyLine, id: "second-flaky-line" },
  ];
  const run = await runBrowserCase("fresh-context", lines, flakyScreen);

  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.deepEqual(
    run.results.lines.map(({ id, status, attempts }) => ({ id, status, attempts })),
    [
      { id: "first-flaky-line", status: "passed", attempts: 1 },
      { id: "second-flaky-line", status: "unsteady", attempts: 2 },
    ],
  );
});

test("W5: a dead action cannot claim an old or absent result", async () => {
  const idleLine = {
    id: "dead-idle",
    kind: "action",
    handler: "handleSave",
    steps: [
      { do: "click", role: "button", name: "Save draft" },
      { do: "expect", role: "status", name: "Idle", expect: "visible" },
    ],
  };
  const savedLine = {
    ...idleLine,
    id: "dead-saved",
    steps: [
      { do: "click", role: "button", name: "Save draft" },
      { do: "expect", role: "status", name: "Saved", expect: "visible" },
    ],
  };

  const alreadyHeld = await runBrowserCase("dead-idle", [idleLine], saveScreen);
  assert.equal(alreadyHeld.result.status, 1, `${alreadyHeld.result.stdout}\n${alreadyHeld.result.stderr}`);
  assert.match(alreadyHeld.result.stdout, /already held/);

  const absent = await runBrowserCase("dead-saved", [savedLine], saveScreen);
  assert.equal(absent.result.status, 1, `${absent.result.stdout}\n${absent.result.stderr}`);
});

test("W6: a missing app route is an operational refusal", async () => {
  const run = await runBrowserCase("missing-route", [passLine], passScreen, { route: "/missing/" });
  assert.equal(run.result.status, 2, `${run.result.stdout}\n${run.result.stderr}`);
  assert.match(run.result.stderr, /\/missing\//);
});

test("W7: a later live action cannot prove an earlier dead action", async () => {
  const line = {
    id: "dead-then-live",
    kind: "action",
    handler: "handlePass",
    steps: [
      { do: "click", role: "button", name: "Save draft" },
      { do: "expect", role: "status", name: "Idle", expect: "visible" },
      { do: "click", role: "button", name: "Pass action" },
      { do: "expect", role: "status", name: "Passed", expect: "visible" },
    ],
  };
  const screen = "export function S(){ const handleSave=()=>{}; const handlePass=()=>{}; return (<main><button onClick={handleSave}>Save draft</button><button onClick={handlePass}>Pass action</button></main>); }\n";

  const run = await runBrowserCase("dead-then-live", [line], screen);

  assert.equal(run.result.status, 1, `${run.result.stdout}\n${run.result.stderr}`);
  assert.match(run.result.stdout, /already held before step 1/);
});
