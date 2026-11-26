import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as counterApi from "../scripts/behaviour-check/count-handlers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "..");
const counter = path.join(repository, "scripts", "behaviour-check", "count-handlers.mjs");
const fixture = path.join(here, "fixtures", "behaviour-app");

const twiceSource = "export function S(){ const save=()=>{}; return (<main><button onClick={save}>Save draft</button><button onClick={save}>Save and close</button></main>); }";
const inlineSource = "export function S(){ const [t,setTab]=useState('a'); return (<main><button onClick={() => setTab('a')}>A</button><button onClick={() => setTab('b')}>B</button><button onClick={() => { setTab('c'); deleteAll(); }}>Delete everything</button></main>); }";
const spreadSource = "export function S(){ const p={onClick:()=>wipe()}; return (<main><button {...p}>Wipe</button><Menu onSelect={pick}/></main>); }";
const primarySource = `export function PrimaryScreen() {
  const handlePass = () => {};
  const handleFlaky = () => {};
  const handleMessage = () => {};
  const handleKeyDown = () => {};

  return (
    <main>
      <button onClick={handlePass}>Pass action</button>
      <button onClick={handleFlaky}>Flaky action</button>
      <input aria-label="Message" onChange={handleMessage} onKeyDown={handleKeyDown} />
    </main>
  );
}
`;

function line(id, handler, steps, covers) {
  const value = { id, kind: "action", handler, steps };
  if (covers) value.covers = covers;
  return value;
}

function list(lines, extra = {}) {
  return { screen: "Screen.jsx", ...extra, lines };
}

async function writeCase(source, value) {
  const folder = await mkdtemp(path.join(tmpdir(), "count-handlers-"));
  const screen = path.join(folder, "Screen.jsx");
  const listFile = path.join(folder, "screen.behaviours.json");
  await writeFile(screen, source);
  await writeFile(listFile, `${JSON.stringify(value, null, 2)}\n`);
  return { folder, screen, listFile };
}

function runCounter(listFile, options = {}) {
  const args = [counter, "--list", listFile];
  if (options.screen) args.push("--screen", options.screen);
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
  });
}

function atOf(source, needle, occurrence = 1) {
  let index = -1;
  for (let count = 0; count < occurrence; count += 1) {
    index = source.indexOf(needle, index + 1);
  }
  assert.notEqual(index, -1, `expected to find ${needle}`);
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return `${lines.length}:${lines.at(-1).length + 1}`;
}

test("A1: each repeated handler occurrence needs its own element step", async () => {
  const files = await writeCase(twiceSource, list([
    line("save", "save", [
      { do: "click", role: "button", name: "Save draft" },
      { do: "expect", role: "status", name: "Saved", expect: "visible" },
    ]),
  ]));
  const result = runCounter(files.listFile);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Save and close/);
});

test("A2: inline callbacks stay inline and cannot be covered by a named handler", async () => {
  const files = await writeCase(inlineSource, list([
    line("tab", "setTab", [{ do: "click", role: "button", name: "A" }]),
  ]));
  const result = runCounter(files.listFile);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Delete everything/);
  assert.match(result.stderr, /'B'/);
  assert.match(result.stderr, /line 'tab' names handler 'setTab' but exercises no element carrying it/);
});

test("A3: spreads and untied component handlers are separate missing entries", async () => {
  const files = await writeCase(spreadSource, list([
    line("pick", "pick", [{ do: "click", role: "button", name: "Something unrelated" }]),
  ]));
  const result = runCounter(files.listFile);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\{\.\.\.\}[^\n]*button[^\n]*Wipe/);
  assert.match(result.stderr, /onSelect[^\n]*Menu/);
});

test("A4: the complete primary fixture resolves its screen from the list", () => {
  const result = runCounter(path.join(fixture, "behaviours", "primary.behaviours.json"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 handler props on 3 elements/);
});

test("A5: a focus step does not cover a keyboard handler", async () => {
  const files = await writeCase(primarySource, list([
    line("pass", "handlePass", [{ do: "click", role: "button", name: "Pass action" }]),
    line("flaky", "handleFlaky", [{ do: "click", role: "button", name: "Flaky action" }]),
    line("message", "handleMessage", [{ do: "click", role: "textbox", name: "Message" }]),
    line("keyboard", "handleKeyDown", [
      { do: "focus", role: "textbox", name: "Message" },
      { do: "expect", role: "status", name: "Submitted", expect: "visible" },
    ]),
  ]));
  const result = runCounter(files.listFile);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /onKeyDown/);
});

test("A5b: focus or type steps do not cover a click handler", async () => {
  const source = "export function S(){const save=()=>{};return <button onClick={save}>Save</button>;}";
  for (const kind of ["focus", "type"]) {
    const step = { do: kind, role: "button", name: "Save" };
    if (kind === "type") step.value = "x";
    const files = await writeCase(source, list([line("save", "save", [step])]));
    const result = runCounter(files.listFile);
    assert.equal(result.status, 1, `${kind}: ${result.stderr}`);
    assert.match(result.stderr, /onClick at 1:\d+ on button/);
  }
  const clicked = await writeCase(source, list([line("save", "save", [{ do: "click", role: "button", name: "Save" }])]));
  assert.equal(runCounter(clicked.listFile).status, 0);
});

test("A6: componentRoles ties custom components to steps", async () => {
  const source = "export function S(){const save=()=>{};return <Button onClick={save}>Save</Button>;}";
  const lines = [line("save", "save", [{ do: "click", role: "button", name: "Save" }])];
  const withoutRoles = await writeCase(source, list(lines));
  const refused = runCounter(withoutRoles.listFile);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /role unknown/);

  const withRoles = await writeCase(source, list(lines, { componentRoles: { Button: "button" } }));
  const passed = runCounter(withRoles.listFile);
  assert.equal(passed.status, 0, passed.stderr);
});

test("A7: covers declares untied entries but refuses tied and nonexistent entries", async () => {
  const spreadAt = atOf(spreadSource, "{...p}");
  const selectAt = atOf(spreadSource, "onSelect");
  const declared = await writeCase(spreadSource, list([
    line("spread", "spread", [{ do: "click", role: "button", name: "Wipe" }], [{ prop: "{...}", at: spreadAt }]),
    line("pick", "pick", [{ do: "click", role: "menu", name: "Choose" }], [{ prop: "onSelect", at: selectAt }]),
  ]));
  const passed = runCounter(declared.listFile);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /2 declared/);

  const tiedSource = "export function S(){const save=()=>{};return <button onClick={save}>Save</button>;}";
  const tiedAt = atOf(tiedSource, "onClick");
  const tied = await writeCase(tiedSource, list([
    line("save", "save", [{ do: "click", role: "button", name: "Save" }], [{ prop: "onClick", at: tiedAt }]),
  ]));
  const tiedResult = runCounter(tied.listFile);
  assert.equal(tiedResult.status, 1, tiedResult.stderr);
  assert.match(tiedResult.stderr, /which is tied to button 'Save'/);

  const absent = await writeCase(tiedSource, list([
    line("save", "save", [{ do: "click", role: "button", name: "Save" }], [{ prop: "onClick", at: "99:1" }]),
  ]));
  const absentResult = runCounter(absent.listFile);
  assert.equal(absentResult.status, 1, absentResult.stderr);
  assert.match(absentResult.stderr, /which is not in the screen source/);
});

test("A8: duplicate role and name pairs are ambiguous until both are declared", async () => {
  const source = "export function S(){const a=()=>{};return <main><button onClick={a}>Save</button><button onClick={a}>Save</button></main>;}";
  const firstAt = atOf(source, "onClick", 1);
  const secondAt = atOf(source, "onClick", 2);
  const refused = await writeCase(source, list([
    line("save", "a", [{ do: "click", role: "button", name: "Save" }]),
  ]));
  const refusedResult = runCounter(refused.listFile);
  assert.equal(refusedResult.status, 1, refusedResult.stderr);
  assert.match(refusedResult.stderr, /ambiguous/);

  const declared = await writeCase(source, list([
    line("first", "a", [{ do: "click", role: "button", name: "Save" }], [{ prop: "onClick", at: firstAt }]),
    line("second", "a", [{ do: "press", role: "button", name: "Save" }], [{ prop: "onClick", at: secondAt }]),
  ]));
  const declaredResult = runCounter(declared.listFile);
  assert.equal(declaredResult.status, 0, declaredResult.stderr);
  assert.match(declaredResult.stdout, /2 declared/);
});

test("A9: a standalone copy loads TypeScript through NODE_PATH", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "standalone-counter-"));
  const copiedCounter = path.join(folder, "count-handlers.mjs");
  await copyFile(counter, copiedCounter);
  const source = "export function S(){const save=()=>{};return <button onClick={save}>Save</button>;}";
  const files = await writeCase(source, list([
    line("save", "save", [{ do: "click", role: "button", name: "Save" }]),
  ]));
  const result = spawnSync(process.execPath, [copiedCounter, "--list", files.listFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_PATH: process.env.NODE_PATH || path.join(repository, "node_modules"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("A10: discovery preserves three inline occurrences and element identities", () => {
  const entries = counterApi.findActionHandlers(inlineSource, "Screen.jsx");
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.handler), ["inline", "inline", "inline"]);
  assert.equal(new Set(entries.map((entry) => entry.element.at)).size, 3);
});

test("invalid componentRoles and covers shapes are input errors", async () => {
  const source = "export function S(){return <button onClick={save}>Save</button>;}";
  for (const value of [
    list([], { componentRoles: { Button: "" } }),
    list([{ id: "bad", kind: "action", handler: null, steps: [], covers: [{ prop: "onClick" }] }]),
  ]) {
    const files = await writeCase(source, value);
    const result = runCounter(files.listFile);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /could not run/);
  }
});

test("resolveScreen and checkListCoverage use the list file directory", async () => {
  const source = "export function S(){return <button onClick={save}>Save</button>;}";
  const value = list([line("save", "save", [{ do: "click", role: "button", name: "Save" }])]);
  const files = await writeCase(source, value);
  assert.equal(counterApi.resolveScreen(files.listFile, value), files.screen);
  const result = await counterApi.checkListCoverage({ listFile: files.listFile, list: value });
  assert.equal(result.missing.length, 0);
  assert.equal(result.covered.length, 1);
});

test("an untied declaration needs an action step", async () => {
  const source = "export function S(){return <Menu onSelect={pick}/>;}";
  const at = atOf(source, "onSelect");
  const files = await writeCase(source, list([
    line("pick", "pick", [{ do: "expect", role: "status", name: "Done", expect: "visible" }], [{ prop: "onSelect", at }]),
  ]));
  const result = runCounter(files.listFile);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /action step/);
});
