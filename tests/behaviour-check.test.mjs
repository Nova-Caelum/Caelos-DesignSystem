import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OperationalError,
  runBehaviourCheck,
  runCli,
} from "../scripts/behaviour-check/run-behaviours.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "behaviour-app");
const behaviours = path.join(fixture, "behaviours");
const counter = path.join(here, "..", "scripts", "behaviour-check", "count-handlers.mjs");

class FakeDriver {
  constructor(failures = {}) {
    this.failures = new Map(Object.entries(failures));
  }

  async beginLine() {}

  async performStep(_step, context) {
    const key = `${context.line.id}:${context.stepIndex}`;
    const remaining = this.failures.get(key) ?? 0;
    if (remaining > 0) {
      this.failures.set(key, remaining - 1);
      throw new Error(`planted failure for ${key}`);
    }
  }
}

async function outputPaths(name) {
  const folder = await mkdtemp(path.join(tmpdir(), `behaviour-${name}-`));
  return {
    out: path.join(folder, "results.json"),
    unsteady: path.join(folder, "unsteady-lines.json"),
  };
}

test("(a) every line passing yields exit 0 and zero failures", async () => {
  const output = await outputPaths("pass");
  const run = await runBehaviourCheck({
    app: fixture,
    behaviours,
    ...output,
    driver: new FakeDriver(),
  });

  assert.equal(run.exitCode, 0);
  const results = JSON.parse(await readFile(output.out, "utf8"));
  assert.equal(results.summary.failed, 0);
  assert.equal(results.summary.passed, 5);
});

test("(b) a line failing twice exits 1 and names the line and failing step", async () => {
  const output = await outputPaths("fail");
  const run = await runBehaviourCheck({
    app: fixture,
    behaviours,
    ...output,
    driver: new FakeDriver({ "pass-action:1": 2 }),
  });

  assert.equal(run.exitCode, 1);
  assert.match(run.message, /pass-action/);
  assert.match(run.message, /step 2/);
  assert.equal(run.results.summary.failed, 1);
});

test("(c) a line failing then passing exits 0 and is written as unsteady", async () => {
  const output = await outputPaths("unsteady");
  const run = await runBehaviourCheck({
    app: fixture,
    behaviours,
    ...output,
    driver: new FakeDriver({ "unsteady-action:1": 1 }),
  });

  assert.equal(run.exitCode, 0);
  const unsteady = JSON.parse(await readFile(output.unsteady, "utf8"));
  assert.deepEqual(unsteady.lines.map((line) => line.id), ["unsteady-action"]);
});

test("(d) count-handlers refuses a list missing a fixture handler and names it", async () => {
  const output = await outputPaths("handler");
  const sourceList = JSON.parse(
    await readFile(path.join(behaviours, "primary.behaviours.json"), "utf8"),
  );
  sourceList.lines = sourceList.lines.filter((line) => line.handler !== "handleFlaky");
  const incompleteList = path.join(path.dirname(output.out), "incomplete.behaviours.json");
  await writeFile(incompleteList, `${JSON.stringify(sourceList, null, 2)}\n`);

  const result = spawnSync(
    process.execPath,
    [counter, "--screen", path.join(fixture, "PrimaryScreen.jsx"), "--list", incompleteList],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /handleFlaky/);
});

test("(e) two discovered list files run without configuration naming them", async () => {
  const output = await outputPaths("discovery");
  const run = await runBehaviourCheck({
    app: fixture,
    behaviours,
    ...output,
    driver: new FakeDriver(),
  });

  assert.equal(run.results.summary.files, 2);
  assert.deepEqual(
    run.results.lists.map((entry) => path.basename(entry.file)).sort(),
    ["primary.behaviours.json", "secondary.behaviours.json"],
  );
});

test("(f) missing app, no lists, and unusable browser are loud operational failures", async () => {
  const output = await outputPaths("refusals");
  let missingAppError = "";
  const missingApp = await runCli(
    ["--app", path.join(fixture, "missing"), "--behaviours", behaviours, "--out", output.out, "--unsteady", output.unsteady],
    {
      driverFactory: async () => new FakeDriver(),
      io: { out() {}, error(value) { missingAppError += value; } },
    },
  );
  assert.ok(missingApp >= 2);
  assert.match(missingAppError, /app folder/);
  assert.match(missingAppError, /Next:/);

  const emptyLists = await mkdtemp(path.join(tmpdir(), "behaviour-empty-"));
  let noListsError = "";
  const noLists = await runCli(
    ["--app", fixture, "--behaviours", emptyLists, "--out", output.out, "--unsteady", output.unsteady],
    {
      driverFactory: async () => new FakeDriver(),
      io: { out() {}, error(value) { noListsError += value; } },
    },
  );
  assert.ok(noLists >= 2);
  assert.match(noListsError, /contains no behaviours/);
  assert.match(noListsError, /Next:/);

  let errorText = "";
  const noBrowser = await runCli(
    ["--app", fixture, "--behaviours", behaviours, "--out", output.out, "--unsteady", output.unsteady],
    {
      driverFactory: async () => {
        throw new OperationalError("browser is unusable", "install the cached Chromium browser");
      },
      io: { out() {}, error(value) { errorText += value; } },
    },
  );
  assert.ok(noBrowser >= 2);
  assert.match(errorText, /browser is unusable/);
  assert.match(errorText, /install the cached Chromium browser/);
});
