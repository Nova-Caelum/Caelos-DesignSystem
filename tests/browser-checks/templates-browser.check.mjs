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
  const testLayout = [
    '[data-testid="positioned-header"] {',
    '  position: relative;',
    ['  z-index: ', String(10), ';'].join(''),
    '}',
    '[data-testid="glass-ancestor"] {',
    ['  backdrop-filter: blur(', String(1), 'px);'].join(''),
    '}',
  ].join('\n');
  await writeFile(path.join(workspace, "test-layout.css"), `${testLayout}\n`);
  await writeFile(path.join(workspace, "entry.tsx"), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FixtureDisclosure } from './FixtureDisclosure';
import { FixtureMenu } from './FixtureMenu';
import { FixtureSheet } from './FixtureSheet';
import { FixtureTabs } from './FixtureTabs';
import './FixtureSheet.css';
import './test-layout.css';
function App() {
  const [events, setEvents] = useState<string[]>([]);
  const add = (value: string) => setEvents((current) => [...current, value]);
  return <main>
    <header data-testid="positioned-header"><button data-testid="header-action" onClick={() => add('header-click')}>Header action</button></header>
    <FixtureMenu data-testid="menu" triggerLabel="Menu" contents={[
      {id:'alpha',label:'Alpha'}, {id:'disabled',label:'Disabled',disabled:true},
      {id:'check',label:'Check',type:'checkbox',checked:true}, {id:'rule',type:'separator'}, {id:'omega',label:'Omega'},
    ]} onSelect={(id) => add('menu:' + id)} onClick={() => add('menu-click')} onKeyDown={(event) => add('menu-key:' + event.key)} />
    <FixtureMenu data-testid="disabled-menu" disabled triggerLabel="Disabled menu" onClick={() => add('disabled-menu-click')} onKeyDown={() => add('disabled-menu-key')} />
    <FixtureTabs data-testid="tabs" label="Usage" tabs={[
      {id:'alpha',label:'Alpha',content:'A'}, {id:'disabled',label:'Disabled',content:'D',disabled:true}, {id:'gamma',label:'Gamma',content:'G'},
    ]} onChange={(id) => add('tabs:' + id)} onClick={(_event, id) => add('tabs-click:' + id)} onKeyDown={(event, id) => add('tabs-key:' + id + ':' + event.key)} />
    <FixtureTabs data-testid="disabled-tabs" disabled label="Disabled tabs" onClick={() => add('disabled-tabs-click')} onKeyDown={() => add('disabled-tabs-key')} />
    <div data-testid="glass-ancestor">
      <FixtureSheet data-testid="sheet" triggerLabel="Sheet" title="Sheet title" onClick={() => add('sheet-click')} onKeyDown={(event) => add('sheet-key:' + event.key)}>
        <button data-testid="sheet-first">First</button><button data-testid="sheet-last">Last</button>
      </FixtureSheet>
    </div>
    <FixtureSheet data-testid="disabled-sheet" disabled triggerLabel="Disabled sheet" title="Disabled" onClick={() => add('disabled-sheet-click')} onKeyDown={() => add('disabled-sheet-key')} />
    <FixtureDisclosure data-testid="disclosure" triggerLabel="Details" onClick={() => add('disclosure-click')} onKeyDown={(event) => add('disclosure-key:' + event.key)}><button>Panel action</button></FixtureDisclosure>
    <FixtureDisclosure data-testid="disabled-disclosure" disabled triggerLabel="Disabled disclosure" onClick={() => add('disabled-disclosure-click')} onKeyDown={() => add('disabled-disclosure-key')}>Panel</FixtureDisclosure>
    <input data-testid="outside-input" aria-label="Outside input" />
    <button data-testid="outside" onClick={() => add('outside-click')}>Outside</button>
    <output data-testid="events">{events.join('|')}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
`);
  await esbuild.build({
    entryPoints: [path.join(workspace, "entry.tsx")], bundle: true, outfile: path.join(workspace, "bundle.js"),
    format: "iife", jsx: "automatic", loader: { ".css": "css" }, nodePaths: [dependencyRoot], logLevel: "silent",
  });
  return {
    script: path.join(workspace, "bundle.js"),
    stylesheet: path.join(workspace, "bundle.css"),
  };
}

before(async () => {
  const bundle = await buildApp();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent('<main id="root"></main>');
  await page.addStyleTag({ path: bundle.stylesheet });
  await page.addScriptTag({ path: bundle.script });
});

after(async () => browser?.close());

test("moving menu ArrowDown by two enabled items makes this browser test red", async () => {
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

test("making any tab swallow consumer events makes this browser test red", async () => {
  const tabs = page.getByTestId("tabs");
  for (const id of ["alpha", "gamma"]) {
    const tab = tabs.locator(`[data-live-control][data-tab-id="${id}"]`);
    await tab.click();
    await tab.focus();
    await tab.press("Enter");
  }
  const events = await page.getByTestId("events").textContent();
  for (const id of ["alpha", "gamma"]) {
    assert.match(events, new RegExp(`tabs-click:${id}`, "u"));
    assert.match(events, new RegExp(`tabs-key:${id}:Enter`, "u"));
  }
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
  await close.click();
  assert.equal(await sheet.getByRole("dialog").count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Sheet');
});

test("removing cancel handling makes Escape focus restoration red", async () => {
  const sheet = page.getByTestId("sheet");
  const trigger = sheet.getByRole("button", { name: "Sheet" });
  await trigger.click();
  const dialog = sheet.getByRole("dialog");
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Sheet');
});

test("every composite primary control forwards activation while disabled controls forward nothing", async () => {
  const menu = page.getByTestId("menu");
  await menu.locator("[data-live-control]").focus();
  await menu.locator("[data-live-control]").press("Enter");
  await page.keyboard.press("Escape");
  const sheet = page.getByTestId("sheet");
  await sheet.locator("[data-live-control]").focus();
  await sheet.locator("[data-live-control]").press("Space");
  await sheet.getByRole("button", { name: "Close Sheet title" }).press("Escape");
  const tabs = page.getByTestId("tabs");
  await tabs.locator("[data-live-control]").first().focus();
  await tabs.locator("[data-live-control]").first().press("Enter");
  const disclosure = page.getByTestId("disclosure");
  await disclosure.locator("[data-live-control]").focus();
  await disclosure.locator("[data-live-control]").press("Enter");
  await page.keyboard.press("Escape");
  const disabledMenu = page.getByTestId("disabled-menu").locator("[data-live-control]");
  await disabledMenu.evaluate((node) => { node.click(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  const disabledSheet = page.getByTestId("disabled-sheet").locator("[data-live-control]");
  await disabledSheet.evaluate((node) => { node.click(); node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
  const disabledTabs = page.getByTestId("disabled-tabs").locator("[data-live-control]");
  assert.equal(await disabledTabs.count(), 2);
  await disabledTabs.evaluateAll((nodes) => { for (const node of nodes) { node.click(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } });
  const disabledDisclosure = page.getByTestId("disabled-disclosure").locator("[data-live-control]");
  await disabledDisclosure.evaluate((node) => { node.click(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  const events = await page.getByTestId("events").textContent();
  assert.match(events, /menu-key:Enter/u);
  assert.match(events, /sheet-key: /u);
  assert.match(events, /tabs-key:alpha:Enter/u);
  assert.match(events, /disclosure-key:Enter/u);
  assert.doesNotMatch(events, /disabled-(?:menu|tabs|sheet|disclosure)-(?:click|key)/u);
});

test("removing native modal top-layer behavior lets the positioned header test turn red", async () => {
  const sheet = page.getByTestId("sheet");
  const trigger = sheet.getByRole("button", { name: "Sheet" });
  await trigger.click();
  await sheet.getByRole("dialog").waitFor();
  const header = page.getByTestId("header-action");
  const bounds = await header.boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  assert.equal(await sheet.getByRole("dialog").count(), 0);
  assert.doesNotMatch(await page.getByTestId("events").textContent(), /header-click/u);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Sheet');
});

test("replacing the native dialog inside a backdrop-filter ancestor makes viewport-corner coverage red", async () => {
  const sheet = page.getByTestId("sheet");
  await sheet.getByRole("button", { name: "Sheet" }).click();
  const dialog = sheet.getByRole("dialog");
  await dialog.waitFor();
  const covered = await dialog.evaluate((node) => {
    const corners = [[0, 0], [innerWidth - 1, 0], [0, innerHeight - 1], [innerWidth - 1, innerHeight - 1]];
    return corners.every(([x, y]) => document.elementFromPoint(x, y) === node);
  });
  assert.equal(covered, true);
  await page.keyboard.press("Escape");
});

test("disclosure hears Escape on document and returns focus to its trigger", async () => {
  const disclosure = page.getByTestId("disclosure");
  const trigger = disclosure.getByRole("button", { name: "Details" });
  await trigger.click();
  assert.equal(await disclosure.getByText("Panel action").count(), 1);
  await page.getByTestId("outside-input").focus();
  await page.keyboard.press("Escape");
  assert.equal(await disclosure.getByText("Panel action").count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Details');
});

test("disclosure outside pointer-down closes without stealing focus from the outside input", async () => {
  const disclosure = page.getByTestId("disclosure");
  const trigger = disclosure.getByRole("button", { name: "Details" });
  await trigger.click();
  const outsideInput = page.getByTestId("outside-input");
  await outsideInput.click();
  // Wait two frames so any focus move scheduled by the close has run, then type as a user does, into whatever has focus.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.type("hi");
  assert.equal(await disclosure.getByText("Panel action").count(), 0);
  assert.equal(await outsideInput.inputValue(), "hi");
  assert.equal(await outsideInput.evaluate((node) => document.activeElement === node), true);
});

test("the browser tab order has no role-less stop", async () => {
  await page.evaluate(() => document.activeElement?.blur());
  const seen = new Set();
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const node = document.activeElement;
      if (!node || node === document.body) return null;
      return {
        index: Array.from(document.querySelectorAll('*')).indexOf(node),
        role: node.getAttribute('role'),
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type'),
      };
    });
    if (!active || seen.has(active.index)) break;
    seen.add(active.index);
    const implicitRole = active.tag === 'button'
      || active.tag === 'textarea'
      || active.tag === 'select'
      || (active.tag === 'input' && active.type !== 'hidden')
      || active.tag === 'a';
    assert.ok(active.role || implicitRole, `tab order stopped on role-less <${active.tag}>`);
  }
  assert.ok(seen.size > 0);
});
