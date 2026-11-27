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
const { chromium } = require("playwright");
const dependencyRoot = path.dirname(path.dirname(require.resolve("react/package.json")));

const readJson = async (file) => JSON.parse(await readFile(path.join(fixtures, file), "utf8"));

test("clause 1: the recorded screen inventory covers every evidenced component kind and gives each its exact source line", async () => {
  const inventory = await readJson("screen-kinds.json.fixture");
  const source = (await readFile(path.join(fixtures, "screen-source.tsx.fixture"), "utf8")).split(/\r?\n/u);
  assert.deepEqual(inventory.kinds.map(({ kind }) => kind).sort(), ["button", "input", "menu", "sheet", "tabs"]);
  for (const item of inventory.kinds) {
    assert.equal(source[item.source_line_number - 1], item.source_line, `${item.kind} source evidence drifted`);
  }
});

test("clause 2: every recorded kind has a generator template named after it", async () => {
  const inventory = await readJson("screen-kinds.json.fixture");
  const available = new Set((await readdir(templates)).filter((file) => file.endsWith(".mjs")));
  for (const { kind } of inventory.kinds) assert.ok(available.has(`${kind}.mjs`), `missing templates/${kind}.mjs`);
});

test("clause 3: every Apply template renders a complete recipe and keeps its keyboard behaviour in Chromium", async (context) => {
  const recipes = await readJson("recipes.json.fixture");
  const workspace = await mkdtemp(path.join(tmpdir(), "caelos-templates-"));
  const outputByKind = new Map();
  const variable = (reference) => `var(--fixture-${reference.slice(1, -1).replaceAll(".", "-")})`;
  const buttonPart = { entry: recipes.button.name, name: recipes.button.name, componentName: recipes.button.componentName };

  for (const [kind, recipe] of Object.entries(recipes)) {
    const template = await import(`${pathToFileURL(path.join(templates, `${kind}.mjs`)).href}?test=${Date.now()}`);
    for (const field of template.requiredFields) {
      let value = recipe.record;
      for (const segment of field.split(".")) value = value?.[segment];
      assert.notEqual(value, undefined, `${kind} fixture lacks declared field ${field}`);
    }
    assert.equal(template.validate({ tier: recipe.tier, record: recipe.record }), null, `${kind} fixture must pass template validation`);
    const rendered = template.render({ ...recipe, node: {}, parts: kind === "button" || kind === "input" ? [] : [buttonPart], variable });
    assert.equal(typeof rendered.tsx, "string");
    assert.equal(typeof rendered.css, "string");
    outputByKind.set(kind, rendered);
    await writeFile(path.join(workspace, `${recipe.componentName}.tsx`), rendered.tsx);
    await writeFile(path.join(workspace, `${recipe.componentName}.css`), rendered.css);
  }

  await writeFile(path.join(workspace, "entry.tsx"), `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FixtureButton } from "./FixtureButton";
import { FixtureInput } from "./FixtureInput";
import { FixtureMenu } from "./FixtureMenu";
import { FixtureSheet } from "./FixtureSheet";
import { FixtureTabs } from "./FixtureTabs";

function App() {
  const [events, setEvents] = useState<string[]>([]);
  const add = (event: string) => setEvents((current) => [...current, event]);
  return <>
    <FixtureButton data-testid="button" onClick={() => add("button")}>Button</FixtureButton>
    <FixtureInput data-testid="input" aria-label="Message" onSubmit={(value) => add("input:" + value)} />
    <FixtureMenu data-testid="menu" triggerLabel="Menu" contents={[{ id: "alpha", label: "Alpha", disabled: true }, { id: "beta", label: "Beta" }]} onSelect={(id) => add("menu:" + id)} />
    <FixtureTabs data-testid="tabs" label="Usage" tabs={[{ id: "alpha", label: "Alpha", content: "A" }, { id: "beta", label: "Beta", content: "B" }]} onChange={(id) => add("tabs:" + id)} />
    <FixtureSheet data-testid="sheet" triggerLabel="Sheet" title="Sheet title">Sheet body</FixtureSheet>
    <output data-testid="events">{events.join("|")}</output>
  </>;
}
createRoot(document.getElementById("root")!).render(<App />);
`);
  await esbuild.build({
    entryPoints: [path.join(workspace, "entry.tsx")],
    bundle: true,
    outfile: path.join(workspace, "bundle.js"),
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "css" },
    nodePaths: [dependencyRoot],
    logLevel: "silent",
  });

  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<main id=\"root\"></main>");
  await page.addScriptTag({ path: path.join(workspace, "bundle.js") });

  const button = page.getByTestId("button");
  await button.focus();
  await button.press("Enter");
  await button.press("Escape");
  assert.equal(await button.evaluate((node) => document.activeElement === node), false);

  const input = page.getByTestId("input");
  await input.fill("hello");
  await input.press("Enter");
  await input.focus();
  await input.press("Escape");
  assert.equal(await input.evaluate((node) => document.activeElement === node), false);

  const menu = page.getByTestId("menu");
  const menuTrigger = menu.getByRole("button", { name: "Menu" });
  await menuTrigger.focus();
  await menuTrigger.press("Enter");
  const firstItem = menu.getByRole("menuitem", { name: "Beta" });
  assert.equal(await firstItem.evaluate((node) => document.activeElement === node), true);
  await firstItem.press("Enter");
  assert.equal(await menu.getByRole("menu").count(), 0);
  await menuTrigger.press("Enter");
  await menu.getByRole("menuitem", { name: "Beta" }).press("Escape");
  assert.equal(await menu.getByRole("menu").count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === "Menu");
  assert.equal(await menuTrigger.evaluate((node) => document.activeElement === node), true);

  const tabs = page.getByTestId("tabs");
  const betaTab = tabs.getByRole("tab", { name: "Beta" });
  await betaTab.focus();
  await betaTab.press("Enter");
  assert.equal(await betaTab.getAttribute("aria-selected"), "true");
  await betaTab.press("Escape");
  assert.equal(await betaTab.evaluate((node) => document.activeElement === node), false);

  const sheet = page.getByTestId("sheet");
  const sheetTrigger = sheet.getByRole("button", { name: "Sheet" });
  await sheetTrigger.focus();
  await sheetTrigger.press("Enter");
  assert.equal(await sheet.getByRole("dialog").count(), 1);
  await sheet.getByRole("button", { name: "Close Sheet title" }).press("Escape");
  assert.equal(await sheet.getByRole("dialog").count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === "Sheet");
  assert.equal(await sheetTrigger.evaluate((node) => document.activeElement === node), true);

  assert.equal(await page.getByTestId("events").textContent(), "button|input:hello|menu:beta|tabs:beta");
});

test("attack: a menu recipe with no contents is refused by the real generator", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "caelos-template-attack-"));
  const catalog = path.join(workspace, "catalog");
  const out = path.join(workspace, "out");
  await mkdir(catalog);
  await writeFile(
    path.join(catalog, "03-overlays.tokens.json"),
    await readFile(path.join(fixtures, "bad-menu.tokens.json.fixture")),
  );
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "generate-components.mjs"),
    "--catalog", catalog,
    "--templates", templates,
    "--out", out,
    "--job", "attack",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.generated.length, 0);
  assert.match(response.gaps[0].reason, /required field "contents"/u);
});
