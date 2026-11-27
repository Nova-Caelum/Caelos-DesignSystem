import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests", "fixtures", "templates");
const templates = path.join(root, "templates");
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const dependencyRoot = path.dirname(path.dirname(require.resolve("react/package.json")));
const readJson = async (file) => JSON.parse(await readFile(path.join(fixtures, file), "utf8"));

async function generatedSource(kind) {
  const recipes = await readJson("recipes.json.fixture");
  const recipe = recipes[kind];
  const template = await import(`${pathToFileURL(path.join(templates, `${kind}.mjs`)).href}?source=${Date.now()}-${kind}`);
  const button = recipes.button;
  const buttonPart = { entry: button.name, name: button.name, componentName: button.componentName };
  return template.render({ ...recipe, node: {}, parts: [buttonPart], variable: () => "var(--fixture)" }).tsx;
}

async function generateFixtures() {
  const recipes = await readJson("recipes.json.fixture");
  const workspace = await mkdtemp(path.join(tmpdir(), "caelos-templates-"));
  const outputByKind = new Map();
  const variable = (reference) => `var(--fixture-${reference.slice(1, -1).replaceAll(".", "-")})`;
  const buttonPart = { entry: recipes.button.name, name: recipes.button.name, componentName: recipes.button.componentName };
  for (const [kind, recipe] of Object.entries(recipes)) {
    const template = await import(`${pathToFileURL(path.join(templates, `${kind}.mjs`)).href}?test=${Date.now()}-${kind}`);
    for (const field of template.requiredFields) {
      let value = recipe.record;
      for (const segment of field.split(".")) value = value?.[segment];
      assert.notEqual(value, undefined, `${kind} fixture lacks declared field ${field}`);
    }
    assert.equal(template.validate({ tier: recipe.tier, record: recipe.record }), null, `${kind} fixture must pass validation`);
    const rendered = template.render({ ...recipe, node: {}, parts: kind === "button" || kind === "input" ? [] : [buttonPart], variable });
    outputByKind.set(kind, rendered);
    await writeFile(path.join(workspace, `${recipe.componentName}.tsx`), rendered.tsx);
    await writeFile(path.join(workspace, `${recipe.componentName}.css`), rendered.css);
  }
  return { recipes, workspace, outputByKind };
}

async function renderMarkup(workspace) {
  const entry = path.join(workspace, "server-entry.tsx");
  await writeFile(entry, `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FixtureButton } from './FixtureButton';
import { FixtureDisclosure } from './FixtureDisclosure';
import { FixtureInput } from './FixtureInput';
import { FixtureMenu } from './FixtureMenu';
import { FixtureSheet } from './FixtureSheet';
import { FixtureTabs } from './FixtureTabs';
export const markup = {
  button: renderToStaticMarkup(<FixtureButton>Button</FixtureButton>),
  disclosure: renderToStaticMarkup(<FixtureDisclosure defaultOpen triggerLabel="Details">Panel</FixtureDisclosure>),
  input: renderToStaticMarkup(<FixtureInput state="error" aria-label="Message" />),
  menu: renderToStaticMarkup(<FixtureMenu defaultOpen triggerLabel="Menu" contents={[{id:'check',label:'Check',type:'checkbox',checked:true},{id:'rule',type:'separator'}]} />),
  sheet: renderToStaticMarkup(<FixtureSheet defaultOpen title="Sheet" triggerLabel="Open">Body</FixtureSheet>),
  tabs: renderToStaticMarkup(<FixtureTabs label="Usage" />),
};
`);
  const outfile = path.join(workspace, "server-entry.cjs");
  await esbuild.build({
    entryPoints: [entry], bundle: true, outfile, format: "cjs", platform: "node", jsx: "automatic",
    loader: { ".css": "empty" }, nodePaths: [dependencyRoot], logLevel: "silent",
  });
  delete require.cache[outfile];
  return require(outfile).markup;
}

function createFakeDriver() {
  const state = { active: null, events: [] };
  return {
    state,
    key(target, key, handler, options = {}) {
      const event = {
        key, shiftKey: Boolean(options.shiftKey), target, currentTarget: target,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
      };
      handler?.(event);
      state.events.push({ type: "key", target: target.id, key, prevented: event.defaultPrevented });
      return event;
    },
    click(target, handler) {
      if (target.disabled || target.ariaDisabled) return false;
      handler?.({ target, currentTarget: target, defaultPrevented: false, preventDefault() {} });
      state.events.push({ type: "click", target: target.id });
      return true;
    },
    menu(items, onSelect) {
      const enabled = items.filter((item) => item.type !== "separator" && !item.disabled);
      state.active = enabled[0];
      return {
        key: (key) => this.key(state.active, key, (event) => {
          const current = enabled.indexOf(state.active);
          const next = key === "ArrowDown" ? (current + 1) % enabled.length
            : key === "ArrowUp" ? (current - 1 + enabled.length) % enabled.length : current;
          if (next !== current) { event.preventDefault(); state.active = enabled[next]; }
        }),
        click: (item) => this.click({ ...item, ariaDisabled: item.disabled }, () => onSelect(item.id)),
      };
    },
    tabs(items, onChange) {
      const enabled = items.filter((item) => !item.disabled);
      state.active = enabled[0];
      return (key) => this.key(state.active, key, (event) => {
        const current = enabled.indexOf(state.active);
        const next = key === "ArrowRight" ? (current + 1) % enabled.length
          : key === "ArrowLeft" ? (current - 1 + enabled.length) % enabled.length : current;
        if (next !== current) { event.preventDefault(); state.active = enabled[next]; onChange(state.active.id); }
      });
    },
    sheet(focusables) {
      state.active = focusables[0];
      return (key, shiftKey = false) => this.key(state.active, key, (event) => {
        if (key !== "Tab") return;
        const edge = shiftKey ? focusables[0] : focusables.at(-1);
        if (state.active !== edge) return;
        event.preventDefault();
        state.active = shiftKey ? focusables.at(-1) : focusables[0];
      }, { shiftKey });
    },
  };
}

test("clause 1: the recorded screen inventory covers every evidenced component kind and exact source line", async () => {
  const inventory = await readJson("screen-kinds.json.fixture");
  const source = (await readFile(path.join(fixtures, "screen-source.tsx.fixture"), "utf8")).split(/\r?\n/u);
  assert.deepEqual(inventory.kinds.map(({ kind }) => kind).sort(), ["button", "disclosure", "input", "menu", "sheet", "tabs"]);
  for (const item of inventory.kinds) assert.equal(source[item.source_line_number - 1], item.source_line, `${item.kind} evidence drifted`);
});

test("clause 2: every recorded kind has a generator template named after it", async () => {
  const inventory = await readJson("screen-kinds.json.fixture");
  const available = new Set((await readdir(templates)).filter((file) => file.endsWith(".mjs")));
  for (const { kind } of inventory.kinds) assert.ok(available.has(`${kind}.mjs`), `missing templates/${kind}.mjs`);
});

test("clause 3: every Apply template renders server markup and every declared state", async () => {
  const { recipes, workspace, outputByKind } = await generateFixtures();
  const markup = await renderMarkup(workspace);
  assert.deepEqual(Object.keys(markup).sort(), Object.keys(recipes).sort());
  for (const [kind, recipe] of Object.entries(recipes)) {
    assert.ok(markup[kind].includes(`data-entry="${recipe.name}"`), `${kind} did not render`);
    for (const declared of recipe.record.states) {
      assert.match(outputByKind.get(kind).tsx, new RegExp(`(?:${declared}|${JSON.stringify(declared)})`, "u"), `${kind} drops state ${declared}`);
    }
  }
  assert.match(markup.input, /aria-invalid="true"/u);
  assert.match(markup.menu, /role="menuitemcheckbox"[^>]*aria-checked="true"/u);
  assert.match(markup.menu, /role="separator"/u);
  assert.match(markup.sheet, /role="dialog"[^>]*aria-modal="true"/u);
});

test("fake driver: removing menu arrow-key handling makes this test red", async () => {
  assert.match(await generatedSource("menu"), /event\.key === 'ArrowDown'/u);
  const driver = createFakeDriver();
  const selected = [];
  const items = [{ id: "alpha" }, { id: "disabled", disabled: true }, { id: "check", type: "checkbox" }];
  const menu = driver.menu(items, (id) => selected.push(id));
  const event = menu.key("ArrowDown");
  assert.equal(event.defaultPrevented, true);
  assert.equal(driver.state.active.id, "check");
});

test("fake driver: letting a disabled menu item pass a click makes this test red", async () => {
  assert.match(await generatedSource("menu"), /if \(item\.disabled\) return;/u);
  const driver = createFakeDriver();
  const selected = [];
  const disabled = { id: "disabled", disabled: true };
  const menu = driver.menu([{ id: "alpha" }, disabled], (id) => selected.push(id));
  assert.equal(menu.click(disabled), false);
  assert.deepEqual(selected, []);
});

test("fake driver: removing tabs arrow-key handling makes this test red", async () => {
  assert.match(await generatedSource("tabs"), /event\.key === 'ArrowRight'/u);
  const driver = createFakeDriver();
  const changed = [];
  const key = driver.tabs([{ id: "alpha" }, { id: "disabled", disabled: true }, { id: "gamma" }], (id) => changed.push(id));
  const event = key("ArrowRight");
  assert.equal(event.defaultPrevented, true);
  assert.equal(driver.state.active.id, "gamma");
  assert.deepEqual(changed, ["gamma"]);
});

test("fake driver: removing the sheet focus trap makes this test red", async () => {
  assert.match(await generatedSource("sheet"), /event\.key !== 'Tab'/u);
  const driver = createFakeDriver();
  const first = { id: "first" };
  const last = { id: "last" };
  const key = driver.sheet([first, last]);
  driver.state.active = last;
  const forward = key("Tab");
  assert.equal(forward.defaultPrevented, true);
  assert.equal(driver.state.active, first);
  const reverse = key("Tab", true);
  assert.equal(reverse.defaultPrevented, true);
  assert.equal(driver.state.active, last);
});

test("attack: a menu recipe with no contents is refused by the real generator", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "caelos-template-attack-"));
  const catalog = path.join(workspace, "catalog");
  const out = path.join(workspace, "out");
  await mkdir(catalog);
  await writeFile(path.join(catalog, "03-overlays.tokens.json"), await readFile(path.join(fixtures, "bad-menu.tokens.json.fixture")));
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "generate-components.mjs"), "--catalog", catalog,
    "--templates", templates, "--out", out, "--job", "attack",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.generated.length, 0);
  assert.match(response.gaps[0].reason, /required field "contents"/u);
});
