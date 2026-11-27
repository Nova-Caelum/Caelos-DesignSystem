import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = path.join(root, "tests", "fixtures", "templates");
const templates = path.join(root, "templates");
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const { chromium } = require("playwright");
const dependencyRoot = path.dirname(path.dirname(require.resolve("react/package.json")));
let browser;
let page;

async function buildApp() {
  const recipes = JSON.parse(await readFile(path.join(fixtures, "recipes.json.fixture"), "utf8"));
  const workspace = await mkdtemp(path.join(tmpdir(), "caelos-template-browser-"));
  const variable = (reference) => `var(--fixture-${reference.slice(1, -1).replaceAll(".", "-")})`;
  const buttonPart = { entry: recipes.button.name, name: recipes.button.name, componentName: recipes.button.componentName };
  for (const [kind, recipe] of Object.entries(recipes)) {
    const template = await import(`${pathToFileURL(path.join(templates, `${kind}.mjs`)).href}?browser=${Date.now()}-${kind}`);
    const rendered = template.render({ ...recipe, node: {}, parts: kind === "button" || kind === "input" ? [] : [buttonPart], variable });
    await writeFile(path.join(workspace, `${recipe.componentName}.tsx`), rendered.tsx);
    await writeFile(path.join(workspace, `${recipe.componentName}.css`), rendered.css);
  }
  await writeFile(path.join(workspace, "entry.tsx"), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FixtureDisclosure } from './FixtureDisclosure';
import { FixtureMenu } from './FixtureMenu';
import { FixtureSheet } from './FixtureSheet';
import { FixtureTabs } from './FixtureTabs';
function App() {
  const [events, setEvents] = useState<string[]>([]);
  const add = (value: string) => setEvents((current) => [...current, value]);
  return <main>
    <FixtureMenu data-testid="menu" triggerLabel="Menu" contents={[
      {id:'alpha',label:'Alpha'}, {id:'disabled',label:'Disabled',disabled:true},
      {id:'check',label:'Check',type:'checkbox',checked:true}, {id:'rule',type:'separator'}, {id:'omega',label:'Omega'},
    ]} onSelect={(id) => add('menu:' + id)} onClick={() => add('menu-click')} onKeyDown={(event) => add('menu-key:' + event.key)} />
    <FixtureMenu data-testid="disabled-menu" disabled triggerLabel="Disabled menu" onClick={() => add('disabled-menu-click')} onKeyDown={() => add('disabled-menu-key')} />
    <FixtureTabs data-testid="tabs" label="Usage" tabs={[
      {id:'alpha',label:'Alpha',content:'A'}, {id:'disabled',label:'Disabled',content:'D',disabled:true}, {id:'gamma',label:'Gamma',content:'G'},
    ]} onChange={(id) => add('tabs:' + id)} />
    <FixtureSheet data-testid="sheet" triggerLabel="Sheet" title="Sheet title" onClick={() => add('sheet-click')} onKeyDown={(event) => add('sheet-key:' + event.key)}>
      <button data-testid="sheet-first">First</button><button data-testid="sheet-last">Last</button>
    </FixtureSheet>
    <FixtureSheet data-testid="disabled-sheet" disabled triggerLabel="Disabled sheet" title="Disabled" onClick={() => add('disabled-sheet-click')} onKeyDown={() => add('disabled-sheet-key')} />
    <FixtureDisclosure data-testid="disclosure" triggerLabel="Details"><button>Panel action</button></FixtureDisclosure>
    <button data-testid="outside">Outside</button>
    <output data-testid="events">{events.join('|')}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
`);
  await esbuild.build({
    entryPoints: [path.join(workspace, "entry.tsx")], bundle: true, outfile: path.join(workspace, "bundle.js"),
    format: "iife", jsx: "automatic", loader: { ".css": "css" }, nodePaths: [dependencyRoot], logLevel: "silent",
  });
  return path.join(workspace, "bundle.js");
}

before(async () => {
  const bundle = await buildApp();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ path: bundle });
});

after(async () => browser?.close());

test("removing menu arrow-key handling makes this browser test red", async () => {
  const menu = page.getByTestId("menu");
  await menu.getByRole("button", { name: "Menu" }).click();
  const alpha = menu.getByRole("menuitem", { name: "Alpha" });
  await alpha.waitFor();
  assert.equal(await alpha.evaluate((node) => document.activeElement === node), true);
  await alpha.press("ArrowDown");
  const checkbox = menu.getByRole("menuitemcheckbox", { name: "Check" });
  assert.equal(await checkbox.evaluate((node) => document.activeElement === node), true);
});

test("letting a disabled menu item pass a click makes this browser test red", async () => {
  const item = page.getByTestId("menu").getByRole("menuitem", { name: "Disabled" });
  await item.evaluate((node) => node.click());
  assert.doesNotMatch(await page.getByTestId("events").textContent(), /menu:disabled/u);
});

test("removing tabs arrow-key handling makes this browser test red", async () => {
  const tabs = page.getByTestId("tabs");
  const alpha = tabs.getByRole("tab", { name: "Alpha" });
  await alpha.focus();
  await alpha.press("ArrowRight");
  const gamma = tabs.getByRole("tab", { name: "Gamma" });
  assert.equal(await gamma.getAttribute("aria-selected"), "true");
  assert.equal(await gamma.evaluate((node) => document.activeElement === node), true);
});

test("removing the sheet focus trap makes this browser test red", async () => {
  const sheet = page.getByTestId("sheet");
  const trigger = sheet.getByRole("button", { name: "Sheet" });
  await trigger.click();
  const close = sheet.getByRole("button", { name: "Close Sheet title" });
  await close.waitFor();
  assert.equal(await close.evaluate((node) => document.activeElement === node), true);
  await close.press("Shift+Tab");
  assert.equal(await page.getByTestId("sheet-last").evaluate((node) => document.activeElement === node), true);
  await page.getByTestId("sheet-last").press("Tab");
  assert.equal(await close.evaluate((node) => document.activeElement === node), true);
  await close.press("Escape");
  assert.equal(await sheet.getByRole("dialog").count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Sheet');
});

test("menu and sheet forward activation while disabled roots forward nothing", async () => {
  const menu = page.getByTestId("menu");
  await menu.focus();
  await menu.press("Enter");
  await page.keyboard.press("Escape");
  const sheet = page.getByTestId("sheet");
  await sheet.focus();
  await sheet.press("Space");
  await sheet.getByRole("button", { name: "Close Sheet title" }).press("Escape");
  const disabledMenu = page.getByTestId("disabled-menu");
  await disabledMenu.evaluate((node) => { node.click(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  const disabledSheet = page.getByTestId("disabled-sheet");
  await disabledSheet.evaluate((node) => { node.click(); node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
  const events = await page.getByTestId("events").textContent();
  assert.match(events, /menu-key:Enter/u);
  assert.match(events, /sheet-key: /u);
  assert.doesNotMatch(events, /disabled-(?:menu|sheet)-(?:click|key)/u);
});

test("disclosure closes on Escape and outside click and restores trigger focus", async () => {
  const disclosure = page.getByTestId("disclosure");
  const trigger = disclosure.getByRole("button", { name: "Details" });
  await trigger.click();
  assert.equal(await disclosure.getByText("Panel action").count(), 1);
  await disclosure.getByRole("button", { name: "Panel action" }).press("Escape");
  assert.equal(await disclosure.getByText("Panel action").count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Details');
  await trigger.click();
  await page.getByTestId("outside").click();
  assert.equal(await disclosure.getByText("Panel action").count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Details');
});
