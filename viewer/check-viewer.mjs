#!/usr/bin/env node

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serveStatic } from '../scripts/behaviour-check/run-behaviours.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ViewerCheckError extends Error {
  constructor(message, next) {
    super(message);
    this.name = 'ViewerCheckError';
    this.next = next;
  }
}

function refusal(message, next) {
  return new ViewerCheckError(message, next);
}

function resultFor(entry, state, card, sideBySide) {
  const shown = Boolean(card?.shown);
  const live = Boolean(card?.live);
  const name = typeof card?.live?.name === 'string' ? card.live.name.trim() : '';
  return {
    state,
    shown,
    sideBySide: Boolean(sideBySide),
    live,
    named: live && name === entry,
    responding: false,
    clickResponded: false,
    keyResponded: false,
  };
}

function failuresFor(entry, state) {
  const failures = [];
  if (!state.shown) failures.push(`${entry}/${state.state}: card is not shown`);
  if (state.shown && !state.sideBySide) failures.push(`${entry}/${state.state}: card is not side by side`);
  if (state.shown && !state.live) failures.push(`${entry}/${state.state}: card has no live element`);
  if (state.shown && state.live && !state.named) failures.push(`${entry}/${state.state}: live element has no readable entry name`);
  if (state.shown && state.live && !state.responding) failures.push(`${entry}/${state.state}: live element does not respond to click and key`);
  return failures;
}

function usableDriver(driver) {
  return driver && typeof driver.inspectEntry === 'function' && typeof driver.interact === 'function';
}

export async function runViewerCheck({ driver, entries, out }) {
  if (!usableDriver(driver)) {
    throw refusal(
      'page driver is unusable',
      'provide a driver that implements inspectEntry(entry) and interact(card, interaction)',
    );
  }
  if (!Array.isArray(entries) || !entries.length || entries.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw refusal('entry list is invalid', 'pass a non-empty JSON array of entry ids');
  }

  const results = { entries: [], summary: { checked: entries.length, failed: 0 } };
  const failures = [];

  for (const entry of entries) {
    const inspected = await driver.inspectEntry(entry);
    if (!inspected?.found) {
      results.entries.push({ entry, found: false, states: [] });
      failures.push(`${entry}: entry is unknown`);
      continue;
    }

    const cardsByState = new Map();
    for (const card of inspected.cards ?? []) {
      if (!cardsByState.has(card.state)) cardsByState.set(card.state, []);
      cardsByState.get(card.state).push(card);
    }
    const states = [];
    for (const state of inspected.states ?? []) {
      const cards = cardsByState.get(state) ?? [];
      const card = cards.length === 1 ? cards[0] : undefined;
      const checked = resultFor(entry, state, card, inspected.sideBySide);
      if (checked.shown && checked.named) {
        checked.clickResponded = await driver.interact(card, 'click');
        checked.keyResponded = await driver.interact(card, 'key');
        checked.responding = checked.clickResponded && checked.keyResponded;
      }
      states.push(checked);
      if (cards.length !== 1) {
        failures.push(`${entry}/${state}: expected one card, found ${cards.length}`);
      }
      failures.push(...failuresFor(entry, checked));
    }
    if (!states.length) failures.push(`${entry}: entry has no cards`);
    results.entries.push({ entry, found: true, states });
  }

  results.summary.failed = failures.length;
  await writeFile(out, `${JSON.stringify(results, null, 2)}\n`);
  return {
    exitCode: failures.length ? 1 : 0,
    message: failures.length ? `Viewer check failed:\n${failures.join('\n')}` : `Viewer check passed for ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
    results,
  };
}

function snapshot(node) {
  const style = getComputedStyle(node);
  return JSON.stringify({
    text: node.textContent,
    value: 'value' in node ? node.value : null,
    checked: 'checked' in node ? node.checked : null,
    aria: ['aria-checked', 'aria-expanded', 'aria-pressed', 'aria-selected'].map((name) => node.getAttribute(name)),
    paint: [style.backgroundColor, style.borderColor, style.boxShadow, style.color, style.opacity, style.outlineColor, style.transform],
    active: node === document.activeElement,
  });
}

export async function createPlaywrightDriver(baseUrl, { chromium: injectedChromium } = {}) {
  let chromium = injectedChromium;
  if (!chromium) {
    try {
      ({ chromium } = await import('playwright'));
    } catch (error) {
      throw refusal(`Playwright is unavailable: ${error.message}`, 'run npm ci in the design-system checkout');
    }
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw refusal(
      `Chromium could not start: ${error.message}`,
      'install the Playwright Chromium browser in the configured cache, then rerun test:browser',
    );
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const response = await page.goto(baseUrl, { waitUntil: 'load' });
  if (!response || response.status() >= 400) {
    await browser.close();
    throw refusal(`viewer returned ${response?.status() ?? 'no response'}`, 'build viewer/dist, then rerun the viewer check');
  }

  async function rowFor(entry) {
    const rows = page.locator('[data-family]');
    const index = await rows.evaluateAll((nodes, value) => nodes.findIndex((node) => node.getAttribute('data-family') === value), entry);
    return index < 0 ? undefined : rows.nth(index);
  }

  return {
    async inspectEntry(entry) {
      const row = await rowFor(entry);
      if (!row) return { found: false, states: [], cards: [], sideBySide: false };
      const cards = row.locator('[data-state-card]');
      const cardCount = await cards.count();
      const sideBySide = await row.locator('.state-cards').evaluate((node) => {
        const style = getComputedStyle(node);
        return style.display === 'grid' || style.display === 'flex';
      });
      return {
        found: true,
        sideBySide,
        states: await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state-card') ?? '')),
        cards: await Promise.all(Array.from({ length: cardCount }, async (_, index) => {
          const card = cards.nth(index);
          const live = card.locator('.live-component > *');
          const liveCount = await live.count();
          return {
            state: await card.getAttribute('data-state-card'),
            shown: await card.isVisible(),
            live: liveCount === 1 ? { name: await live.getAttribute('data-entry') ?? '' } : undefined,
            locator: liveCount === 1 ? live : undefined,
          };
        })),
      };
    },
    async interact(card, interaction) {
      if (!card.locator) return false;
      try {
        await card.locator.evaluate((node) => node.blur());
        const before = await card.locator.evaluate(snapshot);
        if (interaction === 'click') await card.locator.click();
        else await card.locator.press('Enter');
        return before !== await card.locator.evaluate(snapshot);
      } catch {
        return false;
      }
    },
    async close() {
      await browser.close();
    },
  };
}

async function readEntries(file) {
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw refusal(`cannot read entry list ${file}: ${error.message}`, 'pass --entries with a JSON array of entry ids');
  }
  if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw refusal(`${file} must contain a non-empty JSON array of entry ids`, 'fix the entry list and rerun the viewer check');
  }
  if (new Set(value).size !== value.length) throw refusal(`${file} repeats an entry id`, 'list each entry id once');
  return value;
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--entries', '--out', '--viewer']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw refusal(
        `invalid argument near '${flag ?? 'end of command'}'`,
        'use --entries <entry-list.json> [--out <results.json>] [--viewer <viewer-dist>]',
      );
    }
    if (Object.hasOwn(values, flag.slice(2))) throw refusal(`argument '${flag}' is repeated`, `pass ${flag} exactly once`);
    values[flag.slice(2)] = path.resolve(value);
  }
  if (!values.entries) {
    throw refusal('required --entries argument is missing', 'use --entries <entry-list.json>');
  }
  return {
    ...values,
    out: values.out ?? path.join(path.dirname(values.entries), 'viewer-check-results.json'),
    viewer: values.viewer ?? path.join(root, 'viewer/dist'),
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
    const viewer = await stat(options.viewer);
    if (!viewer.isDirectory()) throw refusal(`${options.viewer} is not a viewer directory`, 'build viewer/dist, then rerun the viewer check');
    const entries = await readEntries(options.entries);
    server = await serveStatic(options.viewer);
    driver = await driverFactory(server.url);
    const result = await runViewerCheck({ driver, entries, out: options.out });
    io.out(result.message);
    return result.exitCode;
  } catch (error) {
    if (error instanceof ViewerCheckError) {
      io.error(`Viewer check refused: ${error.message}. Next: ${error.next}.`);
      return 2;
    }
    io.error(`Viewer check could not run: ${error instanceof Error ? error.message : String(error)}. Next: fix the named error and rerun the check.`);
    return 2;
  } finally {
    if (driver?.close) await driver.close().catch((error) => io.error(`Browser cleanup failed: ${error.message}`));
    if (server) await server.close().catch((error) => io.error(`Static server cleanup failed: ${error.message}`));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
