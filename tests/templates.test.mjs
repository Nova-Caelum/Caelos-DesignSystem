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

async function renderMarkup(workspace, recipes) {
  const entry = path.join(workspace, "server-entry.tsx");
  const states = Object.fromEntries(Object.entries(recipes).map(([kind, recipe]) => [kind, recipe.record.states]));
  await writeFile(entry, `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FixtureButton } from './FixtureButton';
import { FixtureDisclosure } from './FixtureDisclosure';
import { FixtureInput } from './FixtureInput';
import { FixtureMenu } from './FixtureMenu';
import { FixtureSheet } from './FixtureSheet';
import { FixtureTabs } from './FixtureTabs';
const states = ${JSON.stringify(states)};
export const markup = {
  button: renderToStaticMarkup(<FixtureButton>Button</FixtureButton>),
  disclosure: renderToStaticMarkup(<FixtureDisclosure defaultOpen triggerLabel="Details">Panel</FixtureDisclosure>),
  input: renderToStaticMarkup(<FixtureInput state="error" aria-label="Message" />),
  menu: renderToStaticMarkup(<FixtureMenu defaultOpen triggerLabel="Menu" contents={[{id:'check',label:'Check',type:'checkbox',checked:true},{id:'rule',type:'separator'}]} />),
  sheet: renderToStaticMarkup(<FixtureSheet defaultOpen title="Sheet" triggerLabel="Open">Body</FixtureSheet>),
  tabs: renderToStaticMarkup(<FixtureTabs label="Usage" />),
  states: {
    button: states.button.map((state) => renderToStaticMarkup(<FixtureButton state={state}>Button</FixtureButton>)),
    disclosure: states.disclosure.map((state) => renderToStaticMarkup(<FixtureDisclosure state={state} triggerLabel="Details">Panel</FixtureDisclosure>)),
    input: states.input.map((state) => renderToStaticMarkup(<FixtureInput state={state} aria-label="Message" />)),
    menu: states.menu.map((state) => renderToStaticMarkup(<FixtureMenu state={state} triggerLabel="Menu" />)),
    sheet: states.sheet.map((state) => renderToStaticMarkup(<FixtureSheet state={state} title="Sheet" triggerLabel="Open">Body</FixtureSheet>)),
    tabs: states.tabs.map((state) => renderToStaticMarkup(<FixtureTabs state={state} label="Usage" />)),
  },
  disabled: {
    button: renderToStaticMarkup(<FixtureButton disabled>Button</FixtureButton>),
    disclosure: renderToStaticMarkup(<FixtureDisclosure disabled triggerLabel="Details">Panel</FixtureDisclosure>),
    input: renderToStaticMarkup(<FixtureInput disabled aria-label="Message" />),
    menu: renderToStaticMarkup(<FixtureMenu disabled triggerLabel="Menu" />),
    sheet: renderToStaticMarkup(<FixtureSheet disabled title="Sheet" triggerLabel="Open">Body</FixtureSheet>),
    tabs: renderToStaticMarkup(<FixtureTabs disabled label="Usage" />),
  },
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
  const { recipes, workspace } = await generateFixtures();
  const markup = await renderMarkup(workspace, recipes);
  assert.deepEqual(Object.keys(markup).filter((key) => key !== "states" && key !== "disabled").sort(), Object.keys(recipes).sort());
  for (const [kind, recipe] of Object.entries(recipes)) {
    assert.ok(markup[kind].includes(`data-entry="${recipe.name}"`), `${kind} did not render`);
    assert.equal(markup.states[kind].length, recipe.record.states.length);
    recipe.record.states.forEach((declared, index) => {
      assert.ok(markup.states[kind][index].includes(`data-state="${declared}"`), `${kind} did not render state ${declared}`);
    });
    assert.match(markup.disabled[kind], /disabled=""/u, `${kind} did not render disabled markup`);
  }
  assert.match(markup.menu, /aria-expanded="true"[^>]*aria-haspopup="menu"/u);
  assert.match(markup.menu, /role="menu"/u);
  assert.match(markup.input, /aria-invalid="true"/u);
  assert.match(markup.menu, /role="menuitemcheckbox"[^>]*aria-checked="true"/u);
  assert.match(markup.menu, /role="separator"/u);
  assert.match(markup.tabs, /role="tablist"/u);
  assert.match(markup.tabs, /role="tab"[^>]*aria-selected="true"[^>]*aria-controls=/u);
  assert.match(markup.tabs, /role="tabpanel"[^>]*aria-labelledby=/u);
  assert.match(markup.sheet, /role="dialog"[^>]*aria-modal="true"/u);
  assert.match(markup.sheet, /aria-labelledby=/u);
  assert.match(markup.disclosure, /aria-expanded="true"[^>]*aria-controls=/u);
  for (const kind of ["menu", "tabs", "sheet", "disclosure"]) {
    assert.match(markup[kind], /data-live-control=/u, `${kind} did not mark its primary control`);
    assert.doesNotMatch(markup[kind].match(/^<div[^>]*>/u)?.[0] ?? "", /tabindex=/u, `${kind} root remains a tab stop`);
  }
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
