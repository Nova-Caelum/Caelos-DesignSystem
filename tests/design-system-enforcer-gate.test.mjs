// JavaScript port of test_design_system_enforcer_gate.py.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const GATE = path.join(REPO, 'scripts', 'design-system-enforcer-gate', 'design-system-enforcer-gate.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'gate-app');
const hex = (...digits) => ['#', ...digits].join('');
const named = (...parts) => parts.join('');
const TOKEN_TEXT = hex('e', 'e', 'e', 'e', 'e', 'e');
const TOKEN_GROUND = hex('1', '0', '1', '0', '1', '0');
const TOKEN_SHADOW = hex('0', '0', '0', '0', '0', '0');
const BAD_COLOUR = hex('f', 'f', '0', '0', '0', '0');
const BAD_SHADOW = ['rgb', 'a', '(', '0', ',', '0', ',', '0', ',', '.', '4', ')'].join('');
const BAD_FILL = named('r', 'ed');

const TOKENS = `:root {
  --base-space-px-4: 4px; --base-space-px-12: 12px;
  --sys-color-text: ${TOKEN_TEXT}; --sys-color-ground: ${TOKEN_GROUND};
  --base-radius-md: 8px;
  --sys-shadow-1: 0 1px 2px ${TOKEN_SHADOW};
  --base-type-size-px-16: 16px; --base-type-weight-500: 500; --base-type-family-ui: Inter;
  --base-motion-duration-fast: 120ms; --base-motion-easing-out: cubic-bezier(0.2, 0, 0, 1);
  --base-opacity-fraction-0-5: 0.5;
}
`;

const CONFIG = {
  scan: { include: ['src/**'] },
  tokens: { css: ['tokens.css'] },
  dimensions: { size: { enabled: true }, 'z-index': { enabled: true } },
  missing: {
    gap: { severity: 'error' },
    typography: { severity: 'error' },
    motion: { severity: 'error', required: true },
  },
  kit: { requireClass: [{ id: 'button', tag: 'button', anyOf: 'kit-button' }] },
};

const GOOD_MODULE = `.row { display: flex; gap: var(--base-space-px-12); padding: var(--base-space-px-4);
  border-radius: var(--base-radius-md); font-size: var(--base-type-size-px-16); color: var(--sys-color-text);
  box-shadow: var(--sys-shadow-1); opacity: var(--base-opacity-fraction-0-5);
  transition: opacity var(--base-motion-duration-fast) var(--base-motion-easing-out); }
`;
const GOOD_TSX = `import styles from "./good.module.css";
export function Good() {
  return (<div className={styles.row}><span>Hi</span><button type="button" className={\`${'${styles.row}'} kit-button\`}>Go</button></div>);
}
`;

const makeTemp = (prefix = 'design-system-enforcer-gate-') => mkdtempSync(path.join(tmpdir(), prefix));

function writeFiles(root, files) {
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

function invoke(root, args = []) {
  return spawnSync(process.execPath, [GATE, ...args, root], { encoding: 'utf8' });
}

function run(files, config = {}, args = [], tokens = TOKENS) {
  const root = makeTemp();
  writeFiles(root, { 'tokens.css': tokens, ...files });
  writeFileSync(path.join(root, 'ui.config.json'), JSON.stringify({ ...CONFIG, ...config }));
  const proc = invoke(root, ['--config', path.join(root, 'ui.config.json'), '--json', ...args]);
  assert.ok([0, 1].includes(proc.status), proc.stderr);
  return { code: proc.status, report: JSON.parse(proc.stdout), root };
}

const rules = (report) => new Set(report.findings.map((finding) => finding.rule));
const hasRules = (report, expected) => {
  const actual = rules(report);
  for (const rule of expected) assert.ok(actual.has(rule), `${rule} missing from ${JSON.stringify(report.findings)}`);
};

function materializeFixture() {
  const root = makeTemp('gate-app-');
  const copy = (source, destination) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'README.md') continue;
      const from = path.join(source, entry.name);
      if (entry.isDirectory()) {
        copy(from, path.join(destination, entry.name));
      } else if (entry.name.endsWith('.fixture')) {
        const to = path.join(destination, entry.name.slice(0, -'.fixture'.length));
        mkdirSync(path.dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
      }
    }
  };
  copy(FIXTURE, root);
  return root;
}

test('(a) materialized fixture exits 1 and reports raw-equal-to-token and empty required values', () => {
  const root = materializeFixture();
  const proc = invoke(root, ['--json']);
  assert.equal(proc.status, 1, proc.stderr);
  const report = JSON.parse(proc.stdout);
  const raw = report.findings.find((finding) => finding.rule === 'spacing');
  const empty = report.findings.find((finding) => finding.rule === 'missing-motion');
  assert.equal(raw?.file, 'src/raw.css');
  assert.match(raw?.message ?? '', /12px is a hand-written spacing value.*use var\(--base-space-px-12\) \(12px\)/);
  assert.equal(empty?.file, 'src/required.tsx');
  assert.match(empty?.message ?? '', /interactive with no motion token/);
});

test('(b) clean materialized fixture exits 0', () => {
  const root = materializeFixture();
  writeFileSync(path.join(root, 'src', 'raw.css'), `.raw { padding: var(--base-space-px-12); }
.motion { transition: opacity var(--base-motion-duration-fast) var(--base-motion-easing-out); }
`);
  writeFileSync(path.join(root, 'src', 'required.tsx'), 'export const Required = () => <button type="button" className="motion">Save</button>;\n');
  const proc = invoke(root, ['--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout).findings, []);
});

test('(c) bad config exits 2', () => {
  const root = materializeFixture();
  writeFileSync(path.join(root, 'design-system-enforcer-gate.config.json'), '{ invalid');
  const proc = invoke(root, ['--json']);
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /design-system-enforcer-gate:/);
});

test('test_clean_component_passes: clean component passes', () => {
  const { code, report } = run({ 'src/good.module.css': GOOD_MODULE, 'src/good.tsx': GOOD_TSX });
  assert.equal(code, 0);
  assert.deepEqual(report.findings, []);
});

const CSS_CASES = [
  ['colour', `color: ${BAD_COLOUR};`, 'color: var(--sys-color-text);'],
  ['spacing', 'padding: 13px;', 'padding: var(--base-space-px-12);'],
  ['radius', 'border-radius: 5px;', 'border-radius: var(--base-radius-md);'],
  ['shadow', `box-shadow: 0 2px 4px ${BAD_SHADOW};`, 'box-shadow: var(--sys-shadow-1);'],
  ['typography', 'font-size: 15px;', 'font-size: var(--base-type-size-px-16);'],
  ['motion', 'transition: opacity 200ms ease-in;', 'transition: opacity var(--base-motion-duration-fast) var(--base-motion-easing-out);'],
  ['opacity', 'opacity: 0.4;', 'opacity: var(--base-opacity-fraction-0-5);'],
  ['size', 'width: 37px;', 'width: auto;'],
  ['z-index', 'z-index: 7;', 'z-index: 0;'],
  ['fallback', 'padding: var(--base-space-px-4, 3px);', 'padding: var(--base-space-px-4);'],
  ['undefined', 'padding: var(--no-such-token);', 'padding: var(--base-space-px-4);'],
  ['icon-fill', `fill: ${BAD_FILL};`, 'fill: none;'],
];

for (const [rule, bad, good] of CSS_CASES) {
  test(`test_css_rule[${rule}]: violation fails and clean value passes`, () => {
    let result = run({ 'src/a.css': `.a { ${bad} }\n` });
    assert.equal(result.code, 1);
    assert.ok(rules(result.report).has(rule), JSON.stringify(result.report.findings));
    const hit = result.report.findings.find((finding) => finding.rule === rule);
    assert.equal(hit.file, 'src/a.css');
    assert.equal(hit.line, 1);
    result = run({ 'src/a.css': `.a { ${good} }\n` });
    assert.equal(result.code, 0);
    assert.deepEqual(result.report.findings, []);
  });
}

test('test_wrong_token_family_is_a_violation: wrong token family is a violation', () => {
  const { code, report } = run({ 'src/a.css': '.a { padding: var(--sys-color-text); }\n' });
  assert.equal(code, 1);
  assert.ok(rules(report).has('spacing'));
  assert.match(report.findings[0].message, /not one of the spacing token families/);
});

test('test_output_line_format_and_nearest_token: output line format includes nearest token', () => {
  const root = makeTemp();
  writeFiles(root, { 'tokens.css': TOKENS, 'src/a.css': '.a { padding: 13px; }\n', 'ui.config.json': JSON.stringify(CONFIG) });
  const proc = invoke(root, ['--config', path.join(root, 'ui.config.json')]);
  assert.equal(proc.status, 1);
  const line = proc.stdout.split('\n').find((item) => item.includes('[spacing]'));
  assert.match(line, /^\s+src\/a\.css:1  \[spacing\] .+ — .+var\(--base-space-px-12\)/);
});

test('test_dtcg_token_source_and_nearest: DTCG token source supplies nearest token', () => {
  const dtcg = { base: { space: { 'px-12': { $type: 'dimension', $value: { value: 12, unit: 'px' } }, alias: { $type: 'dimension', $value: '{base.space.px-12}' } } } };
  const config = { tokens: { css: [], dtcg: ['tokens.json'] }, missing: { gap: { severity: 'off' }, typography: { severity: 'off' }, motion: { severity: 'off', required: false } } };
  const { code, report } = run({ 'tokens.json': JSON.stringify(dtcg), 'src/a.css': '.a { padding: 13px; margin: var(--base-space-px-12); gap: var(--base-space-alias); }\n' }, config);
  const messages = report.findings.map((finding) => finding.message);
  assert.equal(code, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /var\(--base-space-px-12\)/);
});

const MISSING_OFF = { gap: { severity: 'off' }, typography: { severity: 'off' }, motion: { severity: 'off', required: false } };

test('test_tailwind_arbitrary_values: Tailwind arbitrary values fail bad and pass good', () => {
  const config = { missing: MISSING_OFF };
  let result = run({ 'src/a.tsx': `export const A = () => <div className="p-[13px] text-[${BAD_COLOUR}]">x</div>;\n` }, config);
  assert.equal(result.code, 1);
  hasRules(result.report, ['spacing', 'colour']);
  result = run({ 'src/a.tsx': 'export const A = () => <div className="p-[var(--base-space-px-12)] text-[length:var(--base-type-size-px-16)]">x</div>;\n' }, config);
  assert.equal(result.code, 0, JSON.stringify(result.report.findings));
});

test('test_inline_style_objects: inline style objects fail bad and pass good', () => {
  const config = { missing: MISSING_OFF };
  let result = run({ 'src/a.tsx': 'export const A = () => <div style={{ padding: "13px", paddingLeft: `calc(var(--base-space-px-12) * ${depth})` }} />;\n' }, config);
  assert.equal(result.code, 1);
  assert.deepEqual(result.report.findings.map((finding) => finding.rule), ['spacing']);
  result = run({ 'src/a.tsx': 'export const A = () => <div style={{ padding: "var(--base-space-px-12)", paddingLeft: `calc(var(--base-space-px-12) * ${depth})` }} />;\n' }, config);
  assert.equal(result.code, 0, JSON.stringify(result.report.findings));
});

test('test_panda_escape_hatch_and_token_names: Panda escape hatch and token names fail bad and pass good', () => {
  const config = { styledObjects: { enabled: true, panda: true, shorthands: true } };
  let result = run({ 'src/a.ts': `export const s = css({ padding: '[13px]', bg: '[${BAD_COLOUR}]' });\n` }, config);
  assert.equal(result.code, 1);
  hasRules(result.report, ['spacing', 'colour']);
  result = run({ 'src/a.ts': "export const s = css({ padding: '4', bg: 'sys.ground', margin: '[var(--base-space-px-12)]' });\n" }, config);
  assert.equal(result.code, 0, JSON.stringify(result.report.findings));
});

test('test_icon_svg_and_import: icon SVG, imports, allowed component, and fill are judged', () => {
  const config = { missing: MISSING_OFF };
  let result = run({ 'src/a.tsx': 'export const A = () => <svg viewBox="0 0 1 1"><path d="M0 0L1 1" /></svg>;\n' }, config);
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['icon-svg']));
  result = run({ 'src/a.tsx': 'import { FaBeer } from "react-icons/fa";\nexport const A = () => <FaBeer />;\n' }, config);
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['icon-import']));
  result = run({ 'src/a.tsx': 'import { Brain } from "lucide-react";\nexport const A = () => <Brain />;\n' }, config);
  assert.equal(result.code, 0);
  result = run({ 'src/a.tsx': `import { Brain } from "lucide-react";\nexport const A = () => <Brain fill="${BAD_FILL}" />;\n` }, config);
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['icon-fill']));
});

test('test_kit_class_required: kit class is required', () => {
  const config = { missing: MISSING_OFF };
  let result = run({ 'src/a.tsx': 'export const A = () => <button>x</button>;\n' }, config);
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['button']));
  result = run({ 'src/a.tsx': 'export const A = () => <button className="kit-button">x</button>;\n' }, config);
  assert.equal(result.code, 0);
});

function only(rule, severity = 'error') {
  const missing = Object.fromEntries(Object.entries(MISSING_OFF).map(([key, value]) => [key, { ...value }]));
  const key = { 'missing-gap': 'gap', 'missing-typography': 'typography', 'missing-motion': 'motion' }[rule];
  missing[key] = { severity, ...(key === 'motion' ? { required: true } : {}) };
  return { missing };
}

test('test_missing_gap: missing gap fails, token gap passes, and one child needs no gap', () => {
  const tsx = 'import s from "./a.module.css";\nexport const A = () => <div className={s.row}><i /><b /></div>;\n';
  let result = run({ 'src/a.module.css': '.row { display: flex; }\n', 'src/a.tsx': tsx }, only('missing-gap'));
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['missing-gap']));
  result = run({ 'src/a.module.css': '.row { display: flex; gap: var(--base-space-px-4); }\n', 'src/a.tsx': tsx }, only('missing-gap'));
  assert.equal(result.code, 0);
  result = run({ 'src/a.module.css': '.row { display: flex; }\n', 'src/a.tsx': 'import s from "./a.module.css";\nexport const A = () => <div className={s.row}><i /></div>;\n' }, only('missing-gap'));
  assert.equal(result.code, 0);
});

test('test_missing_typography: missing typography fails and token typography passes', () => {
  let result = run({ 'src/a.tsx': 'export const A = () => <p>text</p>;\n' }, only('missing-typography'));
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['missing-typography']));
  result = run({ 'src/a.module.css': '.t { font-size: var(--base-type-size-px-16); }\n', 'src/a.tsx': 'import s from "./a.module.css";\nexport const A = () => <p className={s.t}>text</p>;\n' }, only('missing-typography'));
  assert.equal(result.code, 0);
});

test('test_missing_motion: missing motion fails and token motion passes', () => {
  const config = { ...only('missing-motion'), kit: { requireClass: [] } };
  let result = run({ 'src/a.tsx': 'export const A = () => <button className="kit-button">x</button>;\n' }, config);
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['missing-motion']));
  result = run({ 'src/a.module.css': '.b { transition: opacity var(--base-motion-duration-fast) var(--base-motion-easing-out); }\n', 'src/a.tsx': 'import s from "./a.module.css";\nexport const A = () => <button className={s.b}>x</button>;\n' }, config);
  assert.equal(result.code, 0);
});

test('test_missing_rule_severity_warn_does_not_fail: missing-rule warning does not fail unless strict', () => {
  let result = run({ 'src/a.tsx': 'export const A = () => <p>text</p>;\n' }, only('missing-typography', 'warn'));
  assert.equal(result.code, 0);
  assert.equal(result.report.warnings, 1);
  assert.deepEqual(rules(result.report), new Set(['missing-typography']));
  result = run({ 'src/a.tsx': 'export const A = () => <p>text</p>;\n' }, only('missing-typography', 'warn'), ['--strict']);
  assert.equal(result.code, 1);
});

test('test_exemption_with_reason_passes_and_prints_reason: exemption with reason passes and reports reason', () => {
  const src = 'export const A = () => <div data-ui-exempt="third-party widget sizing" style={{ padding: "13px" }} />;\n';
  const { code, report } = run({ 'src/a.tsx': src }, only('missing-gap'));
  assert.equal(code, 0);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.exempt.map((entry) => entry.reason), ['third-party widget sizing']);
});

test('test_old_kit_exempt_attribute_is_accepted: old kit exemption attribute is accepted', () => {
  const { code, report } = run({ 'src/a.tsx': 'export const A = () => <button data-kit-exempt="native picker">x</button>;\n' }, only('missing-gap'));
  assert.equal(code, 0);
  assert.equal(report.exempt[0].reason, 'native picker');
});

test('test_exemption_without_reason_is_itself_a_violation: exemption without reason is a violation', () => {
  const { code, report } = run({ 'src/a.tsx': 'export const A = () => <div data-ui-exempt style={{ padding: "13px" }} />;\n' }, only('missing-gap'));
  assert.equal(code, 1);
  hasRules(report, ['exempt-reason', 'spacing']);
});

test('test_css_comment_exemption: CSS comment exemption passes', () => {
  const { code, report } = run({ 'src/a.css': '.a {\n  padding: 13px; /* ui-exempt: legacy embed */\n}\n' });
  assert.equal(code, 0);
  assert.equal(report.exempt[0].rule, 'spacing');
});

test('test_vue_file: Vue file fails bad and passes good', () => {
  const config = { scan: { include: ['src/**'], types: ['vue'] } };
  const bad = '<template><div class="row"><p>a</p><p>b</p></div></template>\n<style>.row { display: flex; padding: 13px; }</style>\n';
  const good = '<template><div class="row"><p>a</p><p>b</p></div></template>\n<style>.row { display: flex; gap: var(--base-space-px-12); padding: var(--base-space-px-4); font-size: var(--base-type-size-px-16); }</style>\n';
  let result = run({ 'src/a.vue': bad }, config);
  assert.equal(result.code, 1);
  hasRules(result.report, ['spacing', 'missing-gap', 'missing-typography']);
  result = run({ 'src/a.vue': good }, config);
  assert.equal(result.code, 0, JSON.stringify(result.report.findings));
});

test('test_svelte_file: Svelte file fails bad and passes good', () => {
  const config = { scan: { include: ['src/**'], types: ['svelte'] } };
  const bad = '<div class="row"><svg viewBox="0 0 1 1"></svg><p>b</p></div>\n<style>.row { display: grid; margin: 5px; }</style>\n';
  const good = '<div class="row"><p>a</p><p>b</p></div>\n<style>.row { display: grid; gap: var(--base-space-px-12); margin: var(--base-space-px-4); font-size: var(--base-type-size-px-16); }</style>\n';
  let result = run({ 'src/a.svelte': bad }, config);
  assert.equal(result.code, 1);
  hasRules(result.report, ['spacing', 'missing-gap', 'icon-svg']);
  result = run({ 'src/a.svelte': good }, config);
  assert.equal(result.code, 0, JSON.stringify(result.report.findings));
});

test('test_kit_wrapper_and_project_rules: kit wrapper and project rules fail bad and pass good', () => {
  const config = {
    missing: MISSING_OFF,
    kit: {
      requireWrapper: [{ id: 'field', class: 'kit-input__control', wrapperAnyOf: '\\bkit-input\\b', alsoAnyOf: '\\bkit-cloud\\b' }],
      projectRequires: [{ id: 'graph', anyOf: 'kit-material-graph' }],
    },
  };
  let result = run({ 'src/a.tsx': 'export const A = () => <div className="kit-input"><input className="kit-input__control" /></div>;\n' }, config);
  assert.equal(result.code, 1);
  assert.deepEqual(rules(result.report), new Set(['field', 'graph']));
  result = run({ 'src/a.tsx': 'export const A = () => <div className="kit-material-graph"><div className="kit-input kit-cloud"><input className="kit-input__control" /></div></div>;\n' }, config);
  assert.equal(result.code, 0, JSON.stringify(result.report.findings));
});

test('test_cli_refuses_missing_directory: CLI refuses missing directory with exit 2', () => {
  const root = makeTemp();
  const proc = invoke(path.join(root, 'nope'));
  assert.equal(proc.status, 2);
});
