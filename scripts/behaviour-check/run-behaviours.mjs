#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  checkListCoverage,
  formatCoverageRefusal,
  InputError,
  resolveScreen,
} from "./count-handlers.mjs";

const LIST_SUFFIX = ".behaviours.json";
const STEP_ACTIONS = new Set(["click", "type", "press", "focus", "expect"]);
const ACTION_STEPS = new Set(["click", "type", "press", "focus"]);
const LINE_KINDS = new Set(["action", "state", "keyboard"]);
const EXPECT_STATES = new Set(["visible", "hidden", "enabled", "disabled", "focused"]);

export class OperationalError extends Error {
  constructor(reason, next) {
    super(reason);
    this.name = "OperationalError";
    this.next = next;
    this.operational = true;
  }
}

function refusal(reason, next) {
  return new OperationalError(reason, next);
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function validateApp(app) {
  if (!app) throw refusal("--app is missing", "pass a built app folder or an http(s) URL");
  if (isWebUrl(app)) return { kind: "url", value: app };
  try {
    const details = await stat(app);
    if (!details.isDirectory()) throw new Error("path is not a folder");
  } catch (error) {
    throw refusal(
      `app folder '${app}' is unavailable: ${error.message}`,
      "build the app and pass its output folder with --app",
    );
  }
  return { kind: "folder", value: path.resolve(app) };
}

export async function discoverBehaviourFiles(folder) {
  let root;
  try {
    const details = await stat(folder);
    if (!details.isDirectory()) throw new Error("path is not a folder");
    root = path.resolve(folder);
  } catch (error) {
    throw refusal(
      `behaviours folder '${folder}' is unavailable: ${error.message}`,
      "create the behaviours folder and add at least one *.behaviours.json file",
    );
  }

  const found = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (
        entry.isFile() &&
        (entry.name === "behaviours.json" || entry.name.endsWith(LIST_SUFFIX))
      ) {
        found.push(target);
      }
    }
  }

  try {
    await walk(root);
  } catch (error) {
    throw refusal(
      `behaviours folder '${folder}' could not be read: ${error.message}`,
      "make the folder and its list files readable, then rerun the check",
    );
  }
  found.sort();
  if (found.length === 0) {
    throw refusal(
      `behaviours folder '${folder}' contains no behaviours.json or *.behaviours.json files`,
      "add a behaviour list for every screen that must be checked",
    );
  }
  return { root, files: found };
}

function validateStep(step, context) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw refusal(`${context} is not an object`, "replace it with a step object that follows behaviours.schema.json");
  }
  if (!STEP_ACTIONS.has(step.do)) {
    throw refusal(`${context} has unsupported do '${step.do}'`, "use click, type, press, focus, or expect");
  }
  for (const field of ["role", "name"]) {
    if (typeof step[field] !== "string" || step[field].length === 0) {
      throw refusal(`${context} has no ${field}`, `give the step an ARIA ${field} string`);
    }
  }
  if ((step.do === "type" || step.do === "press") && typeof step.value !== "string") {
    throw refusal(`${context} needs a string value`, `add value for the ${step.do} step`);
  }
  if (step.do === "expect") {
    const validString = typeof step.expect === "string" && EXPECT_STATES.has(step.expect);
    const validObject =
      step.expect &&
      typeof step.expect === "object" &&
      !Array.isArray(step.expect) &&
      (step.expect.state === undefined || EXPECT_STATES.has(step.expect.state)) &&
      (step.expect.value === undefined || typeof step.expect.value === "string") &&
      (step.expect.text === undefined || typeof step.expect.text === "string") &&
      Object.keys(step.expect).some((key) => ["state", "value", "text"].includes(key));
    if (!validString && !validObject) {
      throw refusal(
        `${context} has an invalid expect value`,
        "use a supported state string or an object containing state, value, or text",
      );
    }
  }
}

function validateList(value, file) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw refusal(`behaviour list '${file}' is not an object`, "make it conform to behaviours.schema.json");
  }
  if (typeof value.screen !== "string" || value.screen.length === 0) {
    throw refusal(`behaviour list '${file}' has no screen`, "set screen to the source file path");
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => !["screen", "route", "componentRoles", "lines"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw refusal(
      `behaviour list '${file}' has unknown top-level key '${unknownKeys[0]}'`,
      "remove keys that are not defined by behaviours.schema.json",
    );
  }
  const routePath = typeof value.route === "string" ? value.route.split("?", 1)[0] : "";
  if (
    typeof value.route !== "string"
    || !value.route.startsWith("/")
    || value.route.startsWith("//")
    || value.route.includes("\\")
    || value.route.includes("#")
    || /\s/.test(value.route)
    || routePath.split("/").includes("..")
  ) {
    throw refusal(
      `behaviour list '${file}' has invalid route '${value.route ?? "missing"}'`,
      "set route to a safe app path beginning with one slash",
    );
  }
  if (!Array.isArray(value.lines) || value.lines.length === 0) {
    throw refusal(`behaviour list '${file}' has no lines`, "add at least one behaviour line for the screen");
  }

  const ids = new Set();
  value.lines.forEach((line, lineIndex) => {
    const context = `${file} line ${lineIndex + 1}`;
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw refusal(`${context} is not an object`, "replace it with a line that follows behaviours.schema.json");
    }
    if (typeof line.id !== "string" || line.id.length === 0) {
      throw refusal(`${context} has no id`, "give every line a stable, non-empty id");
    }
    if (ids.has(line.id)) {
      throw refusal(`${file} repeats line id '${line.id}'`, "give every line in the file a unique id");
    }
    ids.add(line.id);
    if (!LINE_KINDS.has(line.kind)) {
      throw refusal(`${context} has unsupported kind '${line.kind}'`, "use action, state, or keyboard");
    }
    if (line.handler !== null && (typeof line.handler !== "string" || line.handler.length === 0)) {
      throw refusal(`${context} has an invalid handler`, "set handler to its source handler name or null");
    }
    if (!Array.isArray(line.steps) || line.steps.length === 0) {
      throw refusal(`${context} has no steps`, "add at least one role-and-accessible-name step");
    }
    line.steps.forEach((step, stepIndex) => validateStep(step, `${context}, step ${stepIndex + 1}`));
    const hasAction = line.steps.some((step) => ACTION_STEPS.has(step.do));
    if (["action", "keyboard"].includes(line.kind) && !hasAction) {
      throw refusal(
        `${context} ('${line.id}') has kind '${line.kind}' but contains no action step`,
        "add a click, type, press, or focus step",
      );
    }
    if (hasAction && line.steps.at(-1).do !== "expect") {
      throw refusal(
        `${file} line ${lineIndex + 1} ('${line.id}') performs an action but its last step is not an expect`,
        "add an expect step that observes the action's result",
      );
    }
  });
  return value;
}

export async function loadBehaviourLists(folder) {
  const discovery = await discoverBehaviourFiles(folder);
  const lists = [];
  for (const file of discovery.files) {
    let value;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      throw refusal(
        `behaviour list '${file}' is not readable JSON: ${error.message}`,
        "fix the JSON and validate it against behaviours.schema.json",
      );
    }
    lists.push({
      file: path.relative(discovery.root, file),
      path: file,
      ...validateList(value, file),
    });
  }
  return lists;
}

export async function checkCoverage(lists) {
  const coverage = [];
  const refused = [];
  for (const list of lists) {
    let result;
    try {
      result = await checkListCoverage({ listFile: list.path, list });
    } catch (error) {
      if (error instanceof InputError) throw refusal(error.message, error.next);
      throw error;
    }
    if (result.missing.length > 0 || result.problems.length > 0) {
      refused.push({ file: list.file, message: formatCoverageRefusal(result) });
      continue;
    }
    coverage.push({
      file: list.file,
      screen: resolveScreen(list.path, list),
      handlers: result.entries.length,
      covered: result.covered.length,
      declared: result.declared.length,
    });
  }
  return { coverage, refused };
}

function failureDetails(error, step, stepIndex) {
  return {
    step: stepIndex + 1,
    do: step?.do ?? "begin",
    role: step?.role ?? null,
    name: step?.name ?? null,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function attemptLine(driver, line, attempt, route) {
  await driver.beginLine(line, attempt, { route });
  const firstAction = line.steps.findIndex((step) => ACTION_STEPS.has(step.do));
  let lastAction = -1;
  for (let stepIndex = line.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    if (ACTION_STEPS.has(line.steps[stepIndex].do)) {
      lastAction = stepIndex;
      break;
    }
  }
  const finalExpectations = lastAction < 0
    ? []
    : line.steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ step, stepIndex }) => stepIndex > lastAction && step.do === "expect");
  let heldBeforeAction = [];
  for (let stepIndex = 0; stepIndex < line.steps.length; stepIndex += 1) {
    const step = line.steps[stepIndex];
    try {
      if (stepIndex === firstAction) {
        heldBeforeAction = await Promise.all(
          finalExpectations.map(({ step: expectation }) => driver.holds(expectation)),
        );
      }
      await driver.performStep(step, { line, stepIndex, attempt });
    } catch (error) {
      if (error?.operational) throw error;
      return { passed: false, failure: failureDetails(error, step, stepIndex) };
    }
  }
  if (heldBeforeAction.length > 0 && heldBeforeAction.every(Boolean)) {
    const lastExpectation = finalExpectations.at(-1);
    return {
      passed: false,
      failure: failureDetails(
        new Error("expected result already held before the action, so the line proves nothing"),
        lastExpectation.step,
        lastExpectation.stepIndex,
      ),
    };
  }
  return { passed: true };
}

export async function runLines({ driver, lines, file, screen, route }) {
  const results = [];
  for (const line of lines) {
    const first = await attemptLine(driver, line, 1, route);
    if (first.passed) {
      results.push({ file, screen, id: line.id, kind: line.kind, handler: line.handler, status: "passed", attempts: 1 });
      continue;
    }

    const second = await attemptLine(driver, line, 2, route);
    if (second.passed) {
      results.push({
        file,
        screen,
        id: line.id,
        kind: line.kind,
        handler: line.handler,
        status: "unsteady",
        attempts: 2,
        firstFailure: first.failure,
      });
    } else {
      results.push({
        file,
        screen,
        id: line.id,
        kind: line.kind,
        handler: line.handler,
        status: "failed",
        attempts: 2,
        firstFailure: first.failure,
        failure: second.failure,
      });
    }
  }
  return results;
}

async function writeJson(target, value) {
  try {
    await mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    throw refusal(`output '${target}' could not be written: ${error.message}`, "make its parent folder writable and rerun the check");
  }
}

function formatFailure(line) {
  return `${line.file}:${line.id} failed twice at step ${line.failure.step} (${line.failure.do}, role '${line.failure.role}', name '${line.failure.name}'): ${line.failure.message}`;
}

export async function runLoadedBehaviourLists({ driver, lists, coverage, out, unsteady }) {
  const lineResults = [];
  for (const list of lists) {
    lineResults.push(
      ...(await runLines({
        driver,
        lines: list.lines,
        file: list.file,
        screen: list.screen,
        route: list.route,
      })),
    );
  }

  const failed = lineResults.filter((line) => line.status === "failed");
  const unstable = lineResults.filter((line) => line.status === "unsteady");
  const results = {
    schemaVersion: 1,
    lists: lists.map(({ file, screen }) => ({ file, screen })),
    coverage,
    summary: {
      files: lists.length,
      total: lineResults.length,
      passed: lineResults.length - failed.length,
      failed: failed.length,
      unsteady: unstable.length,
    },
    lines: lineResults,
  };
  const unsteadyLines = { schemaVersion: 1, lines: unstable };
  await writeJson(out, results);
  await writeJson(unsteady, unsteadyLines);

  const message = failed.length > 0
    ? `Behaviour check failed. ${failed.map(formatFailure).join("\n")}. Next: fix each named behaviour and rerun the check.`
    : `Behaviour check passed ${lineResults.length} lines from ${lists.length} files; ${unstable.length} unsteady.`;
  return { exitCode: failed.length > 0 ? 1 : 0, message, results, unsteadyLines };
}

function listsNeedHolds(lists) {
  return lists.some((list) => list.lines.some(
    (line) => line.steps.some((step) => ACTION_STEPS.has(step.do)),
  ));
}

export async function runBehaviourCheck({ app, behaviours, out, unsteady, driver }) {
  await validateApp(app);
  const lists = await loadBehaviourLists(behaviours);
  const coverageResult = await checkCoverage(lists);
  if (coverageResult.refused.length > 0) {
    const message = coverageResult.refused
      .map(({ file, message: details }) => `Behaviour check refused: handler coverage failed for ${file}: ${details}`)
      .join("\n");
    return { exitCode: 1, message };
  }
  const needsHolds = listsNeedHolds(lists);
  if (!driver || typeof driver.beginLine !== "function" || typeof driver.performStep !== "function"
    || (needsHolds && typeof driver.holds !== "function")) {
    throw refusal(
      "page driver is unusable",
      "provide a driver that implements beginLine, performStep, and holds for action lines",
    );
  }
  return runLoadedBehaviourLists({
    driver,
    lists,
    coverage: coverageResult.coverage,
    out,
    unsteady,
  });
}

function contentType(file) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  })[path.extname(file)] ?? "application/octet-stream";
}

export async function serveStatic(root) {
  const base = path.resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      let file = path.resolve(base, `.${pathname}`);
      if (file !== base && !file.startsWith(`${base}${path.sep}`)) throw new Error("path escapes app root");
      const details = await stat(file);
      if (details.isDirectory()) file = path.join(file, "index.html");
      response.writeHead(200, { "content-type": contentType(file) });
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Not found: ${error.message}`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function expectationObject(expect) {
  return typeof expect === "string" ? { state: expect } : expect;
}

export async function createPlaywrightDriver(baseUrl, { chromium: injectedChromium } = {}) {
  let chromium = injectedChromium;
  if (!chromium) {
    try {
      ({ chromium } = await import("playwright"));
    } catch (error) {
      throw refusal(`Playwright is unavailable: ${error.message}`, "run npm ci in the design-system checkout");
    }
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw refusal(
      `Chromium could not start: ${error.message}`,
      "install the Playwright Chromium browser in the configured cache, then rerun test:browser",
    );
  }
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  let context;
  let page;
  return {
    async beginLine(_line, attempt, { route }) {
      if (page) await page.close();
      page = undefined;
      if (attempt === 1) {
        if (context) await context.close();
        context = await browser.newContext();
        context.setDefaultTimeout(5_000);
        context.setDefaultNavigationTimeout(15_000);
      }
      if (!context) throw refusal("browser context is unavailable", "start each line with attempt 1");
      page = await context.newPage();
      const routeUrl = new URL(route.slice(1), base).href;
      let response;
      try {
        response = await page.goto(routeUrl, { waitUntil: "load" });
      } catch (error) {
        throw refusal(
          `app route '${route}' could not load: ${error.message}`,
          "make the built app reachable and rerun the behaviour check",
        );
      }
      const status = response?.status() ?? "no response";
      if (!response || status >= 400) {
        throw refusal(
          `app route '${route}' returned ${status}`,
          "make the route available in the built app and rerun the behaviour check",
        );
      }
    },
    async holds(step) {
      try {
        const locator = page.getByRole(step.role, { name: step.name, exact: true });
        const expected = expectationObject(step.expect);
        const count = await locator.count();
        if (count === 0) {
          return expected.state === "hidden"
            && expected.value === undefined
            && expected.text === undefined;
        }
        if (count !== 1) return false;
        if (expected.state === "visible" && !(await locator.isVisible({ timeout: 1_000 }))) return false;
        if (expected.state === "hidden" && (await locator.isVisible({ timeout: 1_000 }))) return false;
        if (expected.state === "enabled" && !(await locator.isEnabled({ timeout: 1_000 }))) return false;
        if (expected.state === "disabled" && !(await locator.isDisabled({ timeout: 1_000 }))) return false;
        if (expected.state === "focused" && !(await locator.evaluate(
          (node) => node === document.activeElement,
          undefined,
          { timeout: 1_000 },
        ))) return false;
        if (expected.value !== undefined
          && (await locator.inputValue({ timeout: 1_000 })) !== expected.value) return false;
        if (expected.text !== undefined
          && (await locator.textContent({ timeout: 1_000 })) !== expected.text) return false;
        return true;
      } catch {
        return false;
      }
    },
    async performStep(step) {
      const locator = page.getByRole(step.role, { name: step.name, exact: true });
      if (step.do === "click") await locator.click();
      else if (step.do === "type") await locator.fill(step.value);
      else if (step.do === "press") await locator.press(step.value);
      else if (step.do === "focus") await locator.focus();
      else {
        const expected = expectationObject(step.expect);
        if (expected.state === "hidden") await locator.waitFor({ state: "hidden" });
        else {
          await locator.waitFor({ state: "visible" });
          if (expected.state === "enabled" && !(await locator.isEnabled())) throw new Error("element is disabled");
          if (expected.state === "disabled" && !(await locator.isDisabled())) throw new Error("element is enabled");
          if (expected.state === "focused" && !(await locator.evaluate((node) => node === document.activeElement))) {
            throw new Error("element is not focused");
          }
        }
        if (expected.value !== undefined && (await locator.inputValue()) !== expected.value) {
          throw new Error(`expected value '${expected.value}'`);
        }
        if (expected.text !== undefined && (await locator.textContent()) !== expected.text) {
          throw new Error(`expected text '${expected.text}'`);
        }
      }
    },
    async close() {
      if (page) await page.close();
      if (context) await context.close();
      await browser.close();
    },
  };
}

function parseArguments(argv) {
  const allowed = new Set(["--app", "--behaviours", "--out", "--unsteady"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw refusal(
        `invalid argument near '${flag ?? "end of command"}'`,
        "use --app <folder-or-url> --behaviours <folder> --out <results.json> --unsteady <unsteady-lines.json>",
      );
    }
    if (values[flag]) throw refusal(`argument '${flag}' is repeated`, `pass ${flag} exactly once`);
    values[flag] = value;
  }
  for (const flag of allowed) {
    if (!values[flag]) throw refusal(`required argument '${flag}' is missing`, `pass ${flag} with its value`);
  }
  return {
    app: values["--app"],
    behaviours: values["--behaviours"],
    out: values["--out"],
    unsteady: values["--unsteady"],
  };
}

const defaultIo = {
  out(value) { process.stdout.write(`${value}\n`); },
  error(value) { process.stderr.write(`${value}\n`); },
};

export async function runCli(argv, { driverFactory = createPlaywrightDriver, io = defaultIo } = {}) {
  let driver;
  let server;
  try {
    const options = parseArguments(argv);
    const app = await validateApp(options.app);
    const lists = await loadBehaviourLists(options.behaviours);
    const coverageResult = await checkCoverage(lists);
    if (coverageResult.refused.length > 0) {
      for (const { file, message } of coverageResult.refused) {
        io.error(`Behaviour check refused: handler coverage failed for ${file}: ${message}`);
      }
      return 1;
    }
    if (app.kind === "folder") server = await serveStatic(app.value);
    const baseUrl = app.kind === "folder" ? server.url : app.value;
    driver = await driverFactory(baseUrl);
    const needsHolds = listsNeedHolds(lists);
    if (!driver || typeof driver.beginLine !== "function" || typeof driver.performStep !== "function"
      || (needsHolds && typeof driver.holds !== "function")) {
      throw refusal("browser driver is unusable", "repair the Playwright driver and rerun the check");
    }
    const result = await runLoadedBehaviourLists({
      driver,
      lists,
      coverage: coverageResult.coverage,
      out: options.out,
      unsteady: options.unsteady,
    });
    io.out(result.message);
    return result.exitCode;
  } catch (error) {
    if (error?.operational) {
      io.error(`Behaviour check refused: ${error.message}. Next: ${error.next}.`);
      return 2;
    }
    io.error(`Behaviour check could not run: ${error instanceof Error ? error.message : String(error)}. Next: fix the named error and rerun the check.`);
    return 2;
  } finally {
    if (driver?.close) await driver.close().catch((error) => io.error(`Browser cleanup failed: ${error.message}`));
    if (server) await server.close().catch((error) => io.error(`Static server cleanup failed: ${error.message}`));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
