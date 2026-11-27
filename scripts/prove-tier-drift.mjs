// Each case gets its own staged change. Check the same snapshot with the CI
// command and a real git commit, then verify that HEAD did not advance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let temp;
let scratch;
const probe = 'src/tiers/1-primitives/probe';
const catalog = 'token_catalog/01-primitives.tokens.json';
const style = (key, val) => 'export const recipe = { ' + key + ': ' + JSON.stringify(val) + ' };';
const css = (key, val) => '.probe { ' + key + ': ' + val + ' }';
const named = 'cy' + 'an';
const raw = 'raw style value';
const cases = [
  ['shorthand','ts',style('px','13.37px'),raw],
  ['original padding regression','css',css('padding','13.37px'),raw],
  ['grid','ts',style('gridTemplateColumns','13.37px 1fr'),raw],
  ['percentage','css',css('width','13.37%'),raw],
  ['named colour','ts',style('backgroundColor',named),raw],
  ['system colour','ts',style('color','Canvas'+'Text'),raw],
  ['palette colour copied into style','ts',style('color','#'+'080817'),raw],
  ['color mix weight','css',css('color','color-mix(in srgb, currentColor 13%, transparent)'),raw],
  ['calc multiplier','css',css('gap','calc(var(--sys-space-stack) * 1.37)'),raw],
  ['var fallback','css',css('gap','var(--sys-space-stack, 13px)'),'token fallback'],
  ['unknown CSS role','css',css('color','var(--il-ink)'),'unknown token'],
  ['JSX numeric prop','tsx','export const item = <Icon size={13} />;',raw],
  ['SVG numeric attribute','tsx','export const item = <path strokeWidth={1.37} />;',raw],
  ['SVG file style attribute','svg','<svg><path stroke-width="1.37" /></svg>',raw],
  ['motion object','tsx','export const item = <motion.div transition={{ duration: 0.137 }} />;',raw],
  ['DOM assignment','ts','el.style.width = "13.37px";',raw],
  ['DOM custom property','ts','el.style.setProperty("--probe", "13.37px");',raw],
  ['DOM style text','ts','el.style.cssText = "padding: 13.37px";',raw],
  ['DOM attribute','ts','el.setAttribute("style","padding: 13.37px");',raw],
  ['timer','ts','setTimeout(run, 337);',raw],
  ['interval','ts','setInterval(run, 337);',raw],
  ['JSX style element','tsx','export const item = <style>{".p { gap: 13px }"}</style>;',raw],
  ['HTML style element','index.html','<style>.x { padding: 13.37px }</style>',raw],
  ['HTML inline style','index.html','<span style="padding: 13.37px"></span>',raw],
  ['tagged CSS template','ts','const rule = styled.div' + '\x60' + 'padding: 13.37px' + '\x60;',raw],
  ['dynamic template','ts','const n=13.37; const s={width:' + '\x60' + '\x24{n}px' + '\x60};',raw],
  ['Tailwind arbitrary utility','tsx','export const item=<div className="hover:w-[13px]" />;','arbitrary utility'],
  ['suppression on clean code','ts','// token-'+'exempt(bogus)\nexport const ok=true;','suppression comment'],
  ['constant concatenation','ts','const n=13.37; const s={width:n+"px"};',raw],
  ['computed key','ts','const prop="width"; const s={[prop]:"13px"};',raw],
  ['cast','ts','const s={width:"13px" as any};',raw],
  ['conditional','ts','const s={width:enabled?"13px":"auto"};',raw],
  ['numeric opacity','ts',style('opacity',0.137),raw],
  ['stack order','ts',style('zIndex',1337),raw],
  ['motion time','ts',style('transitionDuration','137ms'),raw],
  ['transform multiplier','ts',style('transform','scale(.1337)'),raw],
  ['default parameter','ts','function view(sideOffset=8) {}',raw],
  ['design constant','ts','export const CHAT_GAP = 13.37;',raw],
  ['comments in strings','ts','const s={content:"//",padding:"13.37px"};',raw],
  ['multiline numeric','ts','const s={top:\n1337};',raw],
  ['media breakpoint','scss','@media (min-width: 1337px) { .x { display: block } }',raw],
  ['recipe in root config','panda.config.ts','defineRecipe({base:{padding:"13.37px"}});',raw],
  ['slot recipe','ts','defineSlotRecipe({base:{root:{margin:"13.37px"}}});',raw],
  ['global CSS','ts','defineGlobalStyles({body:{padding:"13.37px"}});',raw],
  ['keyframes','theme/keyframes.ts','export const frames={from:{opacity:0.137}};',raw],
  ['fixtures directory','tests/fixtures/probe.ts',style('borderRadius','13px'),raw],
  ['imported JSON style data','preview/settings.json','{"padding":"13.37px"}',raw],
  ['imported JSON value at style sink','ts','import data from "../0-foundations/data.json"; const s={padding:data.measure};',raw],
  ['upward import','ts','import "../2-controls/probe";','import must point down'],
  ['sibling re-export','ts','export * from "./sibling";','import must point down'],
  ['dynamic import','ts','import("../2-controls/probe");','import must point down'],
  ['require','ts','require("../2-controls/probe");','import must point down'],
  ['CSS import','css','@import "../2-controls/probe.css";','import must point down'],
  ['unclassified local dependency','ts','import "../../../preview/probe";','unclassified tier import'],
  ['same-tier source token','ts','token("primitives.shared.spacing.stack");','token must point down'],
  ['unknown source token','ts','token("sys.missing");','unknown token'],
  ['upward catalog alias',catalog,'{units.chat.composer-root.shell-top}','catalog alias must point down'],
  ['sibling catalog alias',catalog,'{primitives.shared.spacing.stack}','catalog alias must point down'],
  ['missing catalog alias',catalog,'{sys.unknown}','unknown catalog token'],
  ['unclassified source','src/loose.ts','export const loose=true;', 'unclassified source tier'],
  ['separate catalog','extra/99-side.tokens.json','{"extra":{"$value":"x"}}','unclassified token catalog'],
  ['second foundation file','token_catalog/00-extra.tokens.json','{"base":{"extra":{"$value":13}}}', 'raw foundations must use the foundation catalog'],
  ['literal font family','ts',style('fontFamily','Example Sans'),'raw font family'],
  ['trailing suppression','ts','const ok=true; // token-'+'exempt(bogus)','suppression comment'],
  ['raw catalog input',catalog,13.37,'raw catalog value'],
];

function command(bin, args, cwd=scratch) {
  return spawnSync(bin,args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024});
}

const CASE_KINDS = new Set([
  'rebuilt-component',
  'reused-component',
  'raw-value-equal-to-token',
  'empty-required-value',
  'non-token-merge',
]);
const CASE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DOT_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;

function assertSafeRelative(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  const normalized = value.replaceAll('\\', '/');
  assert.ok(value.length > 0 && !path.isAbsolute(value), `${label} is an unsafe path`);
  assert.ok(!normalized.split('/').includes('..'), `${label} must stay inside the case workspace`);
  assert.ok(!normalized.includes('\0'), `${label} is an unsafe path`);
}

function assertDotPath(value, label) {
  assert.ok(typeof value === 'string' && DOT_PATH.test(value), `${label} must be a safe dotted path`);
}

function assertRefusalPattern(value, label) {
  assert.ok(typeof value === 'string' && value.length > 0, `${label} must be a non-empty pattern`);
  try {
    new RegExp(value, 'su');
  } catch (error) {
    assert.fail(`${label} is not a valid pattern: ${error.message}`);
  }
}

function validatePlant(entry, caseName, index) {
  const label = `${caseName} plant ${index + 1}`;
  assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `${label} must be an object`);
  assert.ok(entry.surface === 'catalog' || entry.surface === 'app', `${label} has an unknown surface`);
  if (entry.file !== undefined) assertSafeRelative(entry.file, `${label} file`);
  if (entry.fixture !== undefined) assertSafeRelative(entry.fixture, `${label} fixture`);
  if (entry.page !== undefined) assertSafeRelative(entry.page, `${label} page`);
  for (const field of ['source', 'target', 'token', 'record']) {
    if (entry[field] !== undefined) assertDotPath(entry[field], `${label} ${field}`);
  }
  return entry;
}

export function validateProofCase(rawCase, filename = '<case>') {
  try {
    assert.ok(rawCase && typeof rawCase === 'object' && !Array.isArray(rawCase), 'case must be an object');
    assert.equal(rawCase.schemaVersion, 1, 'schemaVersion must be 1');
    assert.ok(typeof rawCase.name === 'string' && CASE_NAME.test(rawCase.name), 'name is invalid');
    assert.ok(CASE_KINDS.has(rawCase.kind), `unknown kind ${rawCase.kind}`);
    const accepted = rawCase.kind === 'reused-component';
    assert.equal(rawCase.expected, accepted ? 'accepted' : 'refused', `${rawCase.kind} has the wrong expectation`);
    if (rawCase.kind === 'non-token-merge') {
      assertSafeRelative(rawCase.file, `${rawCase.name} file`);
      assertDotPath(rawCase.token, `${rawCase.name} token`);
      assert.ok(/^proof\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(rawCase.branch), `${rawCase.name} branch is invalid`);
      assert.equal(rawCase.check, 'tier-proof', `${rawCase.name} must expect tier-proof`);
      assertRefusalPattern(rawCase.expect, `${rawCase.name} expect`);
      assert.equal(rawCase.mutation, 'resolve-alias', `${rawCase.name} has an unknown mutation`);
      assert.equal(rawCase.plants, undefined, `${rawCase.name} must not contain ordinary plants`);
      return rawCase;
    }
    assert.ok(Array.isArray(rawCase.plants), `${rawCase.name} plants must be an array`);
    const plants = rawCase.plants.map((entry, index) => validatePlant(entry, rawCase.name, index));
    assert.equal(plants.length, 2, `${rawCase.name} must have two plants`);
    assert.deepEqual(new Set(plants.map((entry) => entry.surface)), new Set(['catalog', 'app']), `${rawCase.name} must plant catalog and app surfaces`);
    const [catalogPlant] = plants.filter((entry) => entry.surface === 'catalog');
    const [appPlant] = plants.filter((entry) => entry.surface === 'app');
    for (const plant of plants) {
      if (accepted) assert.equal(plant.expect, undefined, `${rawCase.name} accepted plants must not declare expect`);
      else assertRefusalPattern(plant.expect, `${rawCase.name} ${plant.surface} expect`);
    }
    if (rawCase.kind === 'rebuilt-component') {
      assert.equal(catalogPlant.check, 'duplicates');
      assert.equal(appPlant.check, 'page-paint');
      for (const field of ['file', 'source', 'target']) assert.ok(catalogPlant[field], `${rawCase.name} catalog plant needs ${field}`);
      for (const field of ['fixture', 'page']) assert.ok(appPlant[field], `${rawCase.name} app plant needs ${field}`);
    } else if (rawCase.kind === 'reused-component') {
      assert.equal(catalogPlant.check, 'duplicates');
      assert.equal(appPlant.check, 'page-paint');
      for (const field of ['file', 'source', 'target']) assert.ok(catalogPlant[field], `${rawCase.name} catalog plant needs ${field}`);
      for (const field of ['fixture', 'page']) assert.ok(appPlant[field], `${rawCase.name} app plant needs ${field}`);
    } else if (rawCase.kind === 'raw-value-equal-to-token') {
      assert.equal(catalogPlant.check, 'tier-drift');
      assert.equal(catalogPlant.mutation, 'resolve-alias');
      assert.equal(appPlant.check, 'enforcer');
      for (const field of ['file', 'token']) assert.ok(catalogPlant[field], `${rawCase.name} catalog plant needs ${field}`);
      for (const field of ['fixture', 'file']) assert.ok(appPlant[field], `${rawCase.name} app plant needs ${field}`);
    } else if (rawCase.kind === 'empty-required-value') {
      assert.equal(catalogPlant.check, 'recipes');
      assert.equal(appPlant.check, 'enforcer');
      for (const field of ['file', 'record', 'field']) assert.ok(catalogPlant[field], `${rawCase.name} catalog plant needs ${field}`);
      for (const field of ['fixture', 'file']) assert.ok(appPlant[field], `${rawCase.name} app plant needs ${field}`);
    }
    return rawCase;
  } catch (error) {
    throw new Error(`${path.basename(filename)}: ${error.message}`);
  }
}

export function loadProofCaseFile(filename) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(`${path.basename(filename)}: invalid JSON: ${error.message}`);
  }
  return validateProofCase(parsed, filename);
}

export async function loadProofCases(casesFolder) {
  assertSafeRelative(path.basename(path.resolve(casesFolder)), 'cases folder');
  const filenames = readdirSync(casesFolder)
    .filter((name) => name.endsWith('.case.json'))
    .sort();
  assert.ok(filenames.length > 0, `${casesFolder}: no .case.json files`);
  const loaded = filenames.map((name) => loadProofCaseFile(path.join(casesFolder, name)));
  assert.equal(new Set(loaded.map((entry) => entry.name)).size, loaded.length, `${casesFolder}: duplicate case name`);
  return loaded;
}

function getAt(root, dotted) {
  return dotted.split('.').reduce((node, part) => node?.[part], root);
}

function setAt(root, dotted, value) {
  const parts = dotted.split('.');
  const key = parts.pop();
  const parent = parts.reduce((node, part) => node?.[part], root);
  assert.ok(parent && typeof parent === 'object', `cannot find ${dotted}`);
  parent[key] = value;
}

function catalogFiles(root) {
  return readdirSync(path.join(root, 'token_catalog'))
    .filter((name) => name.endsWith('.tokens.json'))
    .map((name) => path.join(root, 'token_catalog', name));
}

function resolveCatalogValue(root, dotted, seen = new Set()) {
  assert.ok(!seen.has(dotted), `catalog alias cycle at ${dotted}`);
  seen.add(dotted);
  let node;
  for (const filename of catalogFiles(root)) {
    node = getAt(JSON.parse(readFileSync(filename, 'utf8')), dotted);
    if (node !== undefined) break;
  }
  assert.ok(node && Object.hasOwn(node, '$value'), `cannot resolve catalog token ${dotted}`);
  const reference = typeof node.$value === 'string' ? node.$value.match(/^\{([^}]+)\}$/u)?.[1] : null;
  return reference ? resolveCatalogValue(root, reference, seen) : structuredClone(node.$value);
}

export function applyCatalogCase(root, caseDefinition, plant = caseDefinition) {
  const filename = path.join(root, plant.file);
  const document = JSON.parse(readFileSync(filename, 'utf8'));
  if (caseDefinition.kind === 'rebuilt-component') {
    const source = getAt(document, plant.source);
    assert.ok(source, `cannot find ${plant.source}`);
    setAt(document, plant.target, structuredClone(source));
  } else if (caseDefinition.kind === 'reused-component') {
    setAt(document, plant.target, {
      '$description': 'Visible proof recipe composed from an existing lower tier.',
      '$extensions': { 'app.caelos': { lifecycle: 'draft', madeOf: [plant.source] } },
    });
  } else if (caseDefinition.kind === 'raw-value-equal-to-token' || caseDefinition.kind === 'non-token-merge') {
    const node = getAt(document, plant.token);
    assert.ok(node && Object.hasOwn(node, '$value'), `cannot find ${plant.token}`);
    node.$value = resolveCatalogValue(root, plant.token);
  } else if (caseDefinition.kind === 'empty-required-value') {
    const record = getAt(document, plant.record);
    assert.ok(record?.$extensions?.['app.caelos'], `cannot find ${plant.record}`);
    record.$extensions['app.caelos'][plant.field] = '';
  } else {
    assert.fail(`unsupported catalog case ${caseDefinition.kind}`);
  }
  writeFileSync(filename, `${JSON.stringify(document, null, 2)}\n`);
}

function materializeFixture(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'README.md') continue;
    const from = path.join(source, entry.name);
    if (entry.isDirectory()) {
      materializeFixture(from, path.join(destination, entry.name));
    } else if (entry.name.endsWith('.fixture')) {
      const to = path.join(destination, entry.name.slice(0, -'.fixture'.length));
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    }
  }
}

function prepareAppCase(root, projectRoot, caseDefinition, plant) {
  materializeFixture(path.join(projectRoot, plant.fixture), root);
  const rawFile = path.join(root, 'src/raw.css');
  const requiredFile = path.join(root, 'src/required.tsx');
  if (caseDefinition.kind !== 'raw-value-equal-to-token') {
    writeFileSync(rawFile, '.raw { padding: var(--base-space-px-12); }\n');
  }
  if (caseDefinition.kind !== 'empty-required-value') {
    writeFileSync(requiredFile, 'export const Required = () => <div />;\n');
  }
  if (caseDefinition.kind === 'rebuilt-component' || caseDefinition.kind === 'reused-component') {
    const configFile = path.join(root, 'design-system-enforcer-gate.config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.pages = ['src/pages/**/*.tsx'];
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    const component = path.join(root, 'src/components/ProofComponent.tsx');
    mkdirSync(path.dirname(component), { recursive: true });
    writeFileSync(component, 'export const ProofComponent = () => <span style={{ color: "var(--base-color-chrome)" }} />;\n');
    const page = path.join(root, plant.page);
    mkdirSync(path.dirname(page), { recursive: true });
    if (caseDefinition.kind === 'rebuilt-component') {
      writeFileSync(page, 'export const ProofRebuilt = () => <main style={{ color: "var(--base-color-chrome)" }} />;\n');
    } else {
      writeFileSync(page, 'import { ProofComponent } from "../components/ProofComponent";\nexport const ProofReused = () => <main style={{ padding: "var(--base-space-px-12)" }}><ProofComponent /></main>;\n');
    }
    const tokenCss = path.join(root, 'tokens.css');
    writeFileSync(tokenCss, `${readFileSync(tokenCss, 'utf8')}\n:root { --base-color-chrome: transparent; }\n`);
  }
}

function initializeCatalogWorkspace(projectRoot) {
  const temp = mkdtempSync(path.join(tmpdir(), 'caelos-planted-catalog-'));
  const root = path.join(temp, 'repo');
  mkdirSync(root);
  cpSync(path.join(projectRoot, 'token_catalog'), path.join(root, 'token_catalog'), { recursive: true });
  const invoke = (bin, args) => spawnSync(bin, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.email', 'planted-proof@example.invalid'],
    ['config', 'user.name', 'Planted proof'],
    ['add', '.'],
    ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'baseline'],
  ]) {
    const result = invoke('git', args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  return { root, temp };
}

async function defaultCheckRunner({ caseDefinition, plant, workspace, projectRoot }) {
  const scriptArgs = plant.check === 'duplicates'
    ? ['scripts/check-duplicates.mjs', '--candidate', workspace, '--base', 'HEAD', '--git-root', workspace]
    : plant.check === 'recipes'
      ? ['scripts/check-recipes.mjs', '--candidate', workspace, '--base', 'HEAD', '--git-root', workspace]
      : plant.check === 'tier-drift'
        ? ['scripts/check-tier-drift.cjs', workspace]
        : ['scripts/check-app.mjs', workspace];
  return spawnSync(process.execPath, [path.join(projectRoot, scriptArgs[0]), ...scriptArgs.slice(1)], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function checkOutput(checked) {
  return `${checked?.stderr ?? ''}${checked?.stdout ?? ''}`;
}

function matchesRefusalReason(output, expected) {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(output);
  }
  return output.includes(expected);
}

function looksLikeCrash(checked, output) {
  if (checked?.error || (checked?.status !== 0 && checked?.status !== 1)) return true;
  return /(?:^|\n)(?:uncaught(?:\s+\w+)?(?:\s+exception)?\b|\s*at\s+(?:file:|[\w$.<]))/iu.test(output);
}

export async function runProofCases({
  casesFolder = path.join(project, 'proof-cases'),
  cases: suppliedCases,
  evidenceOutput,
  projectRoot = project,
  checkRunner = defaultCheckRunner,
} = {}) {
  const loadedDefinitions = suppliedCases ?? await loadProofCases(casesFolder);
  const definitions = loadedDefinitions.map((definition) =>
    validateProofCase(definition, `${definition.name}.case.json`));
  const result = { schemaVersion: 1, cases: [] };
  const refusalPatterns = definitions
    .filter((definition) => definition.expected === 'refused')
    .flatMap((definition) => definition.kind === 'non-token-merge'
      ? [new RegExp(definition.expect, 'su')]
      : definition.plants.map((plant) => new RegExp(plant.expect, 'su')));
  for (const definition of definitions) {
    const caseDefinition = definition;
    if (caseDefinition.kind === 'non-token-merge') {
      result.cases.push({ name: caseDefinition.name, kind: caseDefinition.kind, status: 'not-run', mode: 'on-demand' });
      continue;
    }
    const caseResult = { name: caseDefinition.name, kind: caseDefinition.kind, status: 'passed', plants: [] };
    for (const plant of caseDefinition.plants) {
      let temp;
      let workspace;
      try {
        if (plant.surface === 'catalog') {
          ({ root: workspace, temp } = initializeCatalogWorkspace(projectRoot));
          applyCatalogCase(workspace, caseDefinition, plant);
        } else {
          temp = mkdtempSync(path.join(tmpdir(), 'caelos-planted-app-'));
          workspace = path.join(temp, 'app');
          mkdirSync(workspace);
          prepareAppCase(workspace, projectRoot, caseDefinition, plant);
        }
        const checked = await checkRunner({ caseDefinition, plant, workspace, projectRoot });
        const output = checkOutput(checked);
        const shouldAccept = caseDefinition.expected === 'accepted';
        if (looksLikeCrash(checked, output)) {
          throw new Error(`${caseDefinition.name} ${plant.surface} ${plant.check} check crashed: ${output}`);
        }
        if (shouldAccept) {
          if (checked.status !== 0) {
            throw new Error(`${caseDefinition.name} was wrongly refused on ${plant.surface}: ${output}`);
          }
          if (refusalPatterns.some((pattern) => matchesRefusalReason(output, pattern))) {
            throw new Error(`${caseDefinition.name} ${plant.surface} ${plant.check} check exited 0 but output matched a refusal pattern: ${output}`);
          }
        } else {
          if (checked.status === 0) {
            throw new Error(`${caseDefinition.name} was wrongly accepted on ${plant.surface}`);
          }
          const expected = new RegExp(plant.expect, 'su');
          if (!matchesRefusalReason(output, expected)) {
            throw new Error(`${caseDefinition.name} ${plant.surface} ${plant.check} check refused for the wrong reason; expected /${plant.expect}/: ${output}`);
          }
        }
        caseResult.plants.push({ surface: plant.surface, check: plant.check, status: 'passed' });
      } finally {
        if (temp) rmSync(temp, { recursive: true, force: true });
      }
    }
    result.cases.push(caseResult);
  }
  if (evidenceOutput) {
    mkdirSync(path.dirname(path.resolve(evidenceOutput)), { recursive: true });
    writeFileSync(evidenceOutput, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

function parseRunnerArgs(argv) {
  const options = { casesFolder: path.join(project, 'proof-cases'), validateOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--validate-only') options.validateOnly = true;
    else if (argument === '--cases') options.casesFolder = path.resolve(argv[++index] ?? '');
    else if (argument === '--evidence') options.evidenceOutput = path.resolve(argv[++index] ?? '');
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseRunnerArgs(process.argv.slice(2));
  const definitions = await loadProofCases(options.casesFolder);
  if (options.validateOnly) {
    console.log(`Validated ${definitions.length} proof cases in ${options.casesFolder}`);
    return;
  }
  runLegacyProof();
  const result = await runProofCases({ ...options, cases: definitions });
  const passed = result.cases.filter((entry) => entry.status === 'passed').length;
  const notRun = result.cases.filter((entry) => entry.status === 'not-run').length;
  console.log(`PASS · ${passed}${notRun ? ` · NOT RUN · ${notRun}` : ''} visible planted proof cases`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
function ok(bin,args,cwd) {
  const r=command(bin,args,cwd);
  assert.equal(r.status,0,r.stderr+r.stdout);
  return r.stdout.trim();
}
function write(file,body) {
  const dest=path.join(scratch,file);
  mkdirSync(path.dirname(dest),{recursive:true});
  writeFileSync(dest,body);
}
const git=(...args)=>ok('git',args);
function ci() { return command('sh',[path.join(project,'scripts/check-tier-index.sh'),scratch]); }
function runLegacyProof() {
temp = mkdtempSync(path.join(tmpdir(), 'caelos-tier-proof-'));
scratch = path.join(temp, 'repo');
mkdirSync(scratch);
try {
  ok('git',['checkout-index','--all','--prefix='+scratch+'/'],project);
  git('init','--quiet');
  git('config','user.email','tier-proof@example.invalid');
  git('config','user.name','Tier drift proof');
  // Commit the staged tree first, so the hook judges the probes the way it judges a real
  // commit: against a base, with a remote for source links. A first commit has neither.
  git('add','.');
  git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','baseline');
  git('remote','add','origin','https://github.com/example/catalog');
  mkdirSync(path.join(scratch,'node_modules'));
  for (const dep of Object.keys(JSON.parse(readFileSync(path.join(project,'package.json'),'utf8')).devDependencies)) {
    const link=path.join(scratch,'node_modules',dep);
    mkdirSync(path.dirname(link),{recursive:true});
    symlinkSync(path.join(project,'node_modules',dep),link,'dir');
  }
  ok(process.execPath,[path.join(project,'node_modules/husky/bin.js')]);
  assert.equal(git('config','--get','core.hooksPath'),'.husky/_');
  write('src/tiers/0-foundations/probe.ts','export const role = "sys.space.stack";\n');
  write('src/tiers/0-foundations/data.json',JSON.stringify({measure:'13.37px'}));
  write(probe+'.ts','import { role } from "../0-foundations/probe";\nexport const s = { padding: token("sys.space.stack") };\n');
  write(probe+'.css','.probe { padding: var(--sys-space-stack); }\n');
  git('add','.');
  const clean=ci();
  assert.equal(clean.status,0,clean.stderr+clean.stdout);
  git('commit','--quiet','-m','Clean lower-tier reference and import');
  const initial=git('rev-parse','HEAD');
  console.log('ACCEPT · lower-tier import, source token, CSS token and clean catalog · hook + CI');
  for (const [label,ext,body,reason] of cases) {
    const file=ext.includes('.') ? ext : probe+'.'+ext;
    if (file===catalog) {
      const obj=JSON.parse(readFileSync(path.join(scratch,file)));
      obj.primitives.shared.scrollArea['light-ink'].$value=body;
      write(file,JSON.stringify(obj));
    } else write(file,body+'\n');
    git('add','--',file);
    const direct=ci();
    const hook=command('git',['commit','--quiet','-m',label]);
    for (const [which,result] of [['CI',direct],['hook',hook]]) {
      assert.equal(result.status,1,label+' '+which+': '+result.stderr+result.stdout);
      assert.ok(matchesRefusalReason(result.stderr+result.stdout,reason),label+' '+which+' refused for wrong reason: '+result.stderr+result.stdout);
    }
    assert.equal(git('rev-parse','HEAD'),initial);
    console.log('REJECT · '+label+' · '+reason+' · hook + CI');
    git('restore','--source=HEAD','--staged','--worktree','--',file);
  }
  assert.equal(git('status','--porcelain'),'');
  console.log(cases.length+' violations rejected twice; clean commit accepted.');
} finally {
  rmSync(temp,{recursive:true,force:true});
}
}
