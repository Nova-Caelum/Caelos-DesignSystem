import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPlaywrightDriver,
  OperationalError,
  runBehaviourCheck,
  runCli,
  runLines,
} from "../scripts/behaviour-check/run-behaviours.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "behaviour-app");
const behaviours = path.join(fixture, "behaviours");
const counter = path.join(here, "..", "scripts", "behaviour-check", "count-handlers.mjs");

class FakeDriver {
  constructor(failures = {}, { holds = false } = {}) {
    this.failures = new Map(Object.entries(failures));
    this.holdsValue = holds;
    this.beginCalls = [];
  }

  async beginLine(...args) {
    this.beginCalls.push(args);
  }

  async holds(step) {
    return typeof this.holdsValue === "function" ? this.holdsValue(step) : this.holdsValue;
  }

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

async function writeBehaviourCase(name, list, screenSource = null) {
  const folder = await mkdtemp(path.join(tmpdir(), `behaviour-${name}-`));
  const caseBehaviours = path.join(folder, "behaviours");
  await mkdir(caseBehaviours);
  if (screenSource !== null) await writeFile(path.join(folder, "Screen.jsx"), screenSource);
  await writeFile(
    path.join(caseBehaviours, `${name}.behaviours.json`),
    `${JSON.stringify(list, null, 2)}\n`,
  );
  return { folder, behaviours: caseBehaviours, ...(await outputPaths(name)) };
}

function actionList(lines, overrides = {}) {
  return { screen: "../Screen.jsx", route: "/", lines, ...overrides };
}

function clickLine(id = "save-draft", expectedName = "Saved") {
  return {
    id,
    kind: "action",
    handler: "handleSave",
    steps: [
      { do: "click", role: "button", name: "Save draft" },
      { do: "expect", role: "status", name: expectedName, expect: "visible" },
    ],
  };
}

const saveScreen = "export function S(){ const handleSave=()=>{}; return <button onClick={handleSave}>Save draft</button>; }\n";

function cliArguments(testCase, app = fixture) {
  return [
    "--app", app,
    "--behaviours", testCase.behaviours,
    "--out", testCase.out,
    "--unsteady", testCase.unsteady,
  ];
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
  assert.deepEqual(
    results.coverage.map(({ handlers, covered, declared }) => ({ handlers, covered, declared })),
    [
      { handlers: 4, covered: 4, declared: 0 },
      { handlers: 1, covered: 1, declared: 0 },
    ],
  );
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
    ["--app", "http://example.test/", "--behaviours", behaviours, "--out", output.out, "--unsteady", output.unsteady],
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

test("L1: an action line whose last step is not expect is refused", async () => {
  const line = clickLine("click-only");
  line.steps.pop();
  const testCase = await writeBehaviourCase("missing-expect", actionList([line]), saveScreen);
  let errorText = "";

  const exitCode = await runCli(cliArguments(testCase, "http://example.test/"), {
    driverFactory: async () => new FakeDriver(),
    io: { out() {}, error(value) { errorText += value; } },
  });

  assert.equal(exitCode, 2);
  assert.match(errorText, /click-only/);
  assert.match(errorText, /last step is not an expect/);
});

test("L2: an expected result that already holds before the action fails the line", async () => {
  const testCase = await writeBehaviourCase(
    "already-held",
    actionList([clickLine("already-idle", "Idle")]),
    saveScreen,
  );
  const run = await runBehaviourCheck({
    app: fixture,
    behaviours: testCase.behaviours,
    out: testCase.out,
    unsteady: testCase.unsteady,
    driver: new FakeDriver({}, { holds: true }),
  });

  assert.equal(run.exitCode, 1);
  assert.match(run.message, /already held/);
});

test("L3: handler coverage refuses before the driver factory is called", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "behaviour-coverage-"));
  const caseBehaviours = path.join(folder, "behaviours");
  await mkdir(caseBehaviours);
  const sourceList = JSON.parse(
    await readFile(path.join(behaviours, "primary.behaviours.json"), "utf8"),
  );
  sourceList.route = "/";
  sourceList.screen = path.relative(caseBehaviours, path.join(fixture, "PrimaryScreen.jsx"));
  sourceList.lines = sourceList.lines.filter((line) => line.handler !== "handleFlaky");
  await writeFile(
    path.join(caseBehaviours, "incomplete.behaviours.json"),
    `${JSON.stringify(sourceList, null, 2)}\n`,
  );
  const output = await outputPaths("coverage-refusal");
  let driverCreated = false;
  let errorText = "";

  const exitCode = await runCli([
    "--app", fixture,
    "--behaviours", caseBehaviours,
    "--out", output.out,
    "--unsteady", output.unsteady,
  ], {
    driverFactory: async () => {
      driverCreated = true;
      return new FakeDriver();
    },
    io: { out() {}, error(value) { errorText += value; } },
  });

  assert.equal(exitCode, 1);
  assert.match(errorText, /handleFlaky/);
  assert.equal(driverCreated, false);
});

test("L4: a missing or unsafe route is an operational refusal", async () => {
  const missing = await writeBehaviourCase(
    "missing-route",
    { screen: "../Screen.jsx", lines: [clickLine()] },
    saveScreen,
  );
  const unsafe = await writeBehaviourCase(
    "unsafe-route",
    actionList([clickLine()], { route: "/../x" }),
    saveScreen,
  );

  for (const [testCase, pattern] of [[missing, /route/], [unsafe, /\.\.\/x/]]) {
    let errorText = "";
    const exitCode = await runCli(cliArguments(testCase), {
      driverFactory: async () => new FakeDriver(),
      io: { out() {}, error(value) { errorText += value; } },
    });
    assert.equal(exitCode, 2);
    assert.match(errorText, pattern);
  }
});

test("L5: each fixture list passes its route to beginLine", async () => {
  const output = await outputPaths("routes");
  const driver = new FakeDriver();
  await runBehaviourCheck({ app: fixture, behaviours, ...output, driver });

  assert.ok(driver.beginCalls.length > 0);
  assert.ok(driver.beginCalls.every(([, , options]) => options?.route === "/"));
});

test("L6: retries reuse a context and the next line receives a fresh context", async () => {
  const events = [];
  const pageContexts = [];
  let contextNumber = 0;
  const chromium = {
    async launch() {
      return {
        async newContext() {
          contextNumber += 1;
          const number = contextNumber;
          events.push(`new-context-${number}`);
          return {
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            async newPage() {
              pageContexts.push(number);
              const failExpectation = number === 1 && pageContexts.filter((value) => value === 1).length === 1;
              let acted = false;
              return {
                async goto() { return { status: () => 200 }; },
                getByRole(role) {
                  return {
                    async count() { return 1; },
                    async isVisible() { return role === "status" ? acted : true; },
                    async click() { acted = true; },
                    async waitFor() {
                      if (role === "status" && failExpectation) throw new Error("not ready");
                    },
                    async isEnabled() { return true; },
                    async isDisabled() { return false; },
                    async evaluate() { return false; },
                    async inputValue() { return ""; },
                    async textContent() { return ""; },
                  };
                },
                async close() {},
              };
            },
            async close() { events.push(`close-context-${number}`); },
          };
        },
        async close() { events.push("close-browser"); },
      };
    },
  };
  const driver = await createPlaywrightDriver("http://example.test/", { chromium });
  const lines = [clickLine("first"), clickLine("second")];

  const results = await runLines({ driver, lines, file: "case.json", screen: "Screen.jsx", route: "/" });
  await driver.close();

  assert.deepEqual(results.map(({ status, attempts }) => ({ status, attempts })), [
    { status: "unsteady", attempts: 2 },
    { status: "passed", attempts: 1 },
  ]);
  assert.equal(contextNumber, 2);
  assert.deepEqual(pageContexts, [1, 1, 2]);
  assert.ok(events.indexOf("close-context-1") < events.indexOf("new-context-2"));
});

test("L7: a route returning 404 is an operational refusal naming the route", async () => {
  const testCase = await writeBehaviourCase("missing-app-route", actionList([clickLine()]), saveScreen);
  const chromium = {
    async launch() {
      return {
        async newContext() {
          return {
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            async newPage() {
              return {
                async goto() { return { status: () => 404 }; },
                getByRole() { throw new Error("steps must not run"); },
                async close() {},
              };
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
  let errorText = "";
  const exitCode = await runCli(cliArguments(testCase, "http://example.test/"), {
    driverFactory: (baseUrl) => createPlaywrightDriver(baseUrl, { chromium }),
    io: { out() {}, error(value) { errorText += value; } },
  });

  assert.equal(exitCode, 2);
  assert.match(errorText, /app route '\/' returned 404/);
});

test("L8: a missing screen file is an operational refusal", async () => {
  const testCase = await writeBehaviourCase("missing-screen", actionList([clickLine()]));
  let errorText = "";
  const exitCode = await runCli(cliArguments(testCase), {
    driverFactory: async () => new FakeDriver(),
    io: { out() {}, error(value) { errorText += value; } },
  });

  assert.equal(exitCode, 2);
  assert.match(errorText, /screen source/);
});

test("L9: schema and fixture lists require routes", async () => {
  const schema = JSON.parse(
    await readFile(path.join(here, "..", "scripts", "behaviour-check", "behaviours.schema.json"), "utf8"),
  );
  assert.ok(schema.required.includes("route"));
  for (const file of ["primary.behaviours.json", "secondary.behaviours.json"]) {
    const list = JSON.parse(await readFile(path.join(behaviours, file), "utf8"));
    assert.equal(list.route, "/");
  }
});
