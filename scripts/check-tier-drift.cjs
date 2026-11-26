// The hook and CI both check a checkout-index snapshot, including files outside src/.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(process.argv[2]);
const reasons = new Set();
const tokens = new Map();
const catalogLeaves = [];
const cssTokens = new Map();
const files = [];
const generatedTokensFile = 'generated/tokens.css';

function list(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) list(file);
    else if (entry.isSymbolicLink()) reasons.add(path.relative(root, file) + ': unsupported tracked symlink');
    else files.push(file);
  }
}
list(root);
function tierOf(file) {
  if (file === 'src/tokens.ts') return 0;
  // The Panda adapter consumes Tier 1 material recipes.
  if (file === 'src/material-preset.mjs') return 2;
  const catalog = file.match(/(?:^|\/)token_catalog\/(\d+)-/);
  if (catalog) return Number(catalog[1]);
  const source = file.match(/(?:^|\/)tiers?\/(?:tier[-_])?(\d+)(?:[-_/]|$)|(?:^|\/)tier[-_](\d+)(?:[-_/]|$)/);
  return source ? Number(source[1] ?? source[2]) : undefined;
}
function register(obj, prefix, tier) {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;
    const name = [...prefix, key];
    if ('$value' in value) {
      tokens.set(name.join('.'), tier);
      catalogLeaves.push({ name: name.join('.'), value: value.$value, type: value.$type, tier });
      cssTokens.set('--' + name.join('-'), tier);
    } else register(value, name, tier);
  }
}
for (const f of files.filter(f => f.endsWith('.tokens.json'))) {
  const name = path.relative(root, f);
  if (!/^token_catalog\/\d{2}-[\w.-]+\.tokens\.json$/.test(name)) {
    reasons.add(name + ': unclassified token catalog');
    continue;
  }
  const doc = JSON.parse(fs.readFileSync(f));
  if ('base' in doc && name !== 'token_catalog/00-foundations.tokens.json') {
    reasons.add(name + ': raw foundations must use the foundation catalog');
    continue;
  }
  register(doc, [], tierOf(name));
}
const baseLeaves = new Map(catalogLeaves.filter(leaf => leaf.name.startsWith('base.'))
  .map(leaf => ['--' + leaf.name.replaceAll('.', '-'), leaf]));
function decimalSeconds(value) {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return undefined;
  const fraction = match[3] || '';
  const scale = 3 + fraction.length;
  const digits = (match[2] + fraction).padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale).replace(/^0+(?=\d)/, '');
  const decimal = digits.slice(-scale).replace(/0+$/, '');
  return match[1] + whole + (decimal ? '.' + decimal : '');
}
function generatedBaseValue(leaf) {
  const value = leaf.value;
  if (leaf.type === 'color') return String(value.hex).toLowerCase();
  if (leaf.type === 'dimension') return String(value.value) + value.unit;
  if (leaf.type === 'number' || leaf.type === 'fontWeight') return String(value);
  if (leaf.type === 'fontFamily') {
    const family = name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name) ? name : "'" + name + "'";
    return (Array.isArray(value) ? value : [value]).map(family).join(', ');
  }
  if (leaf.type === 'duration') return value.unit === 'ms' ? decimalSeconds(value.value) + 's' : String(value.value) + 's';
  if (leaf.type === 'cubicBezier') return 'cubic-bezier(' + value.join(', ') + ')';
}
// generated/tokens.css must have exactly the generator's shape: one :root block of `--name: value;`
// declarations and nothing else. This one parse decides both what the file holds and what is verified.
// Only CSS whitespace separates tokens: `\s` would also accept characters CSS reads as part of a name.
const generatedReference = /^var\([ \t\n\r\f]*--[a-z0-9-]+[ \t\n\r\f]*\)$/;
function parseGenerated(text) {
  const shapeError = (pos, reason) => ({ error: { pos, reason } });
  const solid = (from, to = text.length) => from + text.slice(from, to).search(/[^ \t\n\r\f]|$/);
  const open = /^[ \t\n\r\f]*:root[ \t\n\r\f]*\{/.exec(text);
  if (!open) return shapeError(solid(0), 'expected the file to be one :root { } block');
  const start = open[0].length;
  const end = text.indexOf('}', start);
  const nested = text.indexOf('{', start);
  if (nested >= 0 && (end < 0 || nested < end)) return shapeError(nested, 'a block inside :root');
  if (end < 0) return shapeError(solid(0), ':root block is not closed');
  if (solid(end + 1) < text.length) return shapeError(solid(end + 1), 'text after the :root block');
  const declaration = /^[ \t\n\r\f]*(--[a-z0-9-]+)[ \t\n\r\f]*:[ \t\n\r\f]*([^ \t\n\r\f][\s\S]*?)[ \t\n\r\f]*$/;
  const entries = [];
  const seen = new Set();
  const pieces = text.slice(start, end).split(';');
  let offset = start;
  for (const [i, piece] of pieces.entries()) {
    const pos = solid(offset, offset + piece.length);
    offset += piece.length + 1;
    const last = i === pieces.length - 1;
    if (last && pos === offset - 1) return { entries };
    const m = declaration.exec(piece);
    if (!m) return shapeError(pos, 'expected a --name: value declaration with a lower-case name');
    if (last) return shapeError(pos, 'declaration without a terminating semicolon');
    if (seen.has(m[1])) return shapeError(pos, 'duplicate declaration ' + m[1]);
    seen.add(m[1]);
    entries.push({ key: m[1], raw: m[2], pos });
  }
}
for (const leaf of catalogLeaves) {
  if (leaf.name.startsWith('base.') && leaf.tier === 0) continue;
  const target = typeof leaf.value === 'string' && leaf.value.match(/^\{([^{}]+)\}$/)?.[1];
  if (!target) reasons.add(leaf.name + ': raw catalog value');
  else if (!tokens.has(target)) reasons.add(leaf.name + ': unknown catalog token');
  else if (tokens.get(target) >= leaf.tier && !(leaf.tier === 0 && leaf.name.startsWith('sys.') && target.startsWith('base.'))) {
    reasons.add(leaf.name + ': catalog alias must point down');
  }
}
const dom = fs.readFileSync(require.resolve('typescript/lib/lib.dom.d.ts'), 'utf8');
const styleInterface = dom.match(/interface CSSStyleDeclaration \{([\s\S]*?)\n\}/)[1];
const props = new Set([...styleInterface.matchAll(/^\s*(\w+): string;/gm)].map(m => m[1]));
for (const prop of 'sideOffset alignOffset bg p px py pt pr pb pl m mx my gapX gapY rounded w h size duration delay strokeWidth cx cy r rx ry x y x1 x2 y1 y2'.split(' ')) props.add(prop);
const property = key => props.has(key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())) || key.startsWith('--');
const arbitrary = /(?:^|\s|:)[\w-]+-\[[^\]]+\]/;
const numeric = /(?:^|[^\w-])-?(?:\d*\.?\d+)(?:[a-z]+|%)?(?![\w-])/i;
const suppress = /\b(?:token[-_]exempt|(?:palette|drift|tier|token)[-_]ignore|@ts-ignore|eslint-disable|biome-ignore)\b/;
async function main() {
  const { scanText, parseTokens } = await import('./check-palette.mjs');
  for (const f of files) {
    const name = path.relative(root, f);
    const tier = tierOf(name);
    const source = fs.readFileSync(f, 'utf8');
    const palette = name === 'src/tokens.ts' ? parseTokens(source) : undefined;
    const report = (pos, rule) => reasons.add(name + ':' + (source.slice(0,pos).split('\n').length) + ': ' + rule);
    if (tier === undefined && name.startsWith('src/')) report(0,'unclassified source tier');
    function reference(key, registry, pos) {
      if (!registry.has(key)) report(pos, 'unknown token ' + key);
      else if (tier !== undefined && registry.get(key) >= tier) report(pos, 'token must point down: ' + key);
    }
    function value(raw, pos, prop) {
      if (['fontFamily','font-family'].includes(prop) && raw && !/^(?:inherit|initial|unset|revert|var\(|\{)/.test(raw)) report(pos,'raw font family');
      if (/\bvar\(\s*--[\w-]+\s*,/.test(raw)) report(pos, 'token fallback');
      const withoutVars = raw.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, key) => {
        if (!source.includes("'" + key + "':") && !source.includes('"' + key + '":')) reference(key, cssTokens, pos);
        return 'TOKEN';
      }).replace(/\{([\w.-]+)\}/g, (_, key) => { reference(key, tokens, pos); return 'TOKEN'; });
      if (numeric.test(withoutVars) || scanText('a { color: ' + withoutVars + '; }', {allowed: new Set()}).length) report(pos, 'raw style value');
    }
    function declarations(text, pos) {
      for (const m of text.matchAll(/(?:^|[;{(\s])([\w-]+)\s*:\s*([^;{}"']+)/g)) {
        if (property(m[1]) || /^(min|max)-(width|height)$/.test(m[1])) value(m[2], pos+m.index, m[1]);
      }
    }
    function importPath(spec, pos) {
      if (tier === undefined) return;
      const resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(name), spec)) : spec;
      const target = tierOf(resolved);
      if (target !== undefined && target >= tier) report(pos, 'import must point down: ' + spec);
      if (target === undefined && (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('/'))) report(pos, 'unclassified tier import: ' + spec);
    }
    if (/\.(?:s?css|less|html?|vue|svelte|svg)$/i.test(f)) {
      for (const m of source.matchAll(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g)) if (suppress.test(m[0])) report(m.index, 'suppression comment');
      const cssSource = source.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
      if (name === generatedTokensFile) {
        const { error, entries } = parseGenerated(cssSource);
        if (error) report(error.pos, 'not in generated shape: ' + error.reason + '; regenerate with npm run build:tokens');
        else for (const { key, raw, pos } of entries) {
          const leaf = baseLeaves.get(key);
          if (generatedReference.test(raw)) value(raw, pos, key);
          else if (!key.startsWith('--base-')) report(pos, 'raw style value');
          else if (!leaf) report(pos, 'unknown base token ' + key);
          else {
            const expected = generatedBaseValue(leaf);
            if (expected === undefined) report(pos, key + ' unsupported base value type ' + leaf.type);
            else if (raw !== expected) report(pos, key + ' generated base value ' + raw + ' does not equal catalog value ' + expected + '; generated base values must equal their catalog tokens; regenerate with npm run build:tokens, or fix the catalog');
          }
        }
        continue;
      }
      declarations(cssSource, 0);
      for (const m of source.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) declarations(m[2],m.index);
      for (const m of source.matchAll(/\bclass(?:Name)?=["']([^"']+)["']/g)) if (arbitrary.test(m[1])) report(m.index,'arbitrary utility');
      for (const m of source.matchAll(/@(?:import|use|forward)\s+(?:url\()?["']([^"']+)/g)) importPath(m[1], m.index);
      for (const m of source.matchAll(/\b([\w-]+)=["']([^"']+)["']/g)) if (property(m[1])) {
        // Artwork keeps its intrinsic canvas. Rendered icon sizing belongs to the consuming primitive.
        const inSvgRoot = f.endsWith('.svg') && /^<svg\b[^>]*$/i.test(source.slice(0,m.index).trimStart());
        if (!(f.endsWith('.svg') && m[1] === 'd') && !(inSvgRoot && ['width','height'].includes(m[1]))) value(m[2],m.index);
      }
    }
    if (f.endsWith('.json') && !f.endsWith('.tokens.json')) {
      const walk = obj => {
        if (obj && typeof obj === 'object') for (const [key,v] of Object.entries(obj)) {
          if (property(key) && ['number','string'].includes(typeof v)) value(String(v),0);
          walk(v);
        }
      };
      walk(JSON.parse(source));
    }
    if (!/\.[cm]?[jt]sx?$/.test(f)) continue;
    const tree = ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);
    if (tree.parseDiagnostics.length) { report(tree.parseDiagnostics[0].start, 'source parse failure'); continue; }
    const constants = new Map();
    const jsonImports = new Map();
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.name) continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith('.') || !spec.endsWith('.json')) continue;
      const dataPath = path.resolve(path.dirname(f), spec);
      if (files.includes(dataPath)) jsonImports.set(statement.importClause.name.text, JSON.parse(fs.readFileSync(dataPath)));
    }
    function importedData(expr) {
      if (ts.isIdentifier(expr)) return jsonImports.get(expr.text);
      if (ts.isPropertyAccessExpression(expr)) return importedData(expr.expression)?.[expr.name.text];
      if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) return importedData(expr.expression)?.[expr.argumentExpression.text];
    }
    function collect(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) constants.set(n.name.text,n.initializer);
      ts.forEachChild(n,collect);
    }
    collect(tree);
    function literal(n, seen=new Set()) {
      if (!n || seen.has(n)) return '';
      seen = new Set(seen).add(n);
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        const v = importedData(n);
        if (typeof v === 'number' || typeof v === 'string') return String(v);
      }
      if (ts.isPrefixUnaryExpression(n)) return literal(n.operand,seen);
      if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) return n.text;
      if (ts.isIdentifier(n)) return literal(constants.get(n.text),seen);
      if (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isJsxExpression(n) || ts.isSatisfiesExpression(n)) return literal(n.expression,seen);
      if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => (literal(s.expression,seen)||'TOKEN') + s.literal.text).join('');
      if (ts.isBinaryExpression(n) && n.operatorToken.kind===ts.SyntaxKind.PlusToken) return literal(n.left,seen) + literal(n.right,seen);
      return '';
    }
    function inspect(n) {
      const pos = n.getStart(tree);
      for (const c of [...(ts.getLeadingCommentRanges(source,n.pos)||[]), ...(ts.getTrailingCommentRanges(source,n.end)||[])]) if (suppress.test(source.slice(c.pos,c.end))) report(c.pos,'suppression comment');
      if ((ts.isParameter(n) || ts.isBindingElement(n) || ts.isVariableDeclaration(n)) &&
          n.initializer && /^(?:(?:side|align)Offset|size|[A-Z_]*(?:GAP|DURATION|DELAY|RADIUS|WIDTH|HEIGHT|PADDING)[A-Z_]*)$/.test(n.name.getText(tree))) value(literal(n.initializer),pos);
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        if (n.moduleSpecifier) importPath(n.moduleSpecifier.text,pos);
      }
      if (ts.isPropertyAssignment(n) || ts.isJsxAttribute(n)) {
        const key = ts.isComputedPropertyName(n.name) ? literal(n.name.expression) : n.name.text;
        const raw = literal(n.initializer);
        const owner = n.parent?.parent;
        const paletteEntry = palette && owner && ts.isAsExpression(owner) &&
          ts.isVariableDeclaration(owner.parent) && owner.parent.name.getText(tree)==='color' &&
          palette.roles.get(key)?.hex === raw;
        if (key && property(key) && !paletteEntry) {
          if (n.initializer && ts.isConditionalExpression(n.initializer)) for (const branch of [n.initializer.whenTrue,n.initializer.whenFalse]) value(literal(branch),pos);
          else value(raw,pos,key);
        }
        if (key==='style') declarations(raw,pos);
        if (key==='class' || key==='className') if (arbitrary.test(raw)) report(pos,'arbitrary utility');
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind===ts.SyntaxKind.EqualsToken && /\.style(?:\.|\[)/.test(n.left.getText(tree))) {
        const raw=literal(n.right);
        if (n.left.getText(tree).endsWith('.cssText')) declarations(raw,pos); else value(raw,pos);
      }
      if (ts.isCallExpression(n)) {
        const callee=n.expression.getText(tree);
        if (/^(?:require|import)$/.test(callee)) {
          const spec=literal(n.arguments[0]);
          if (spec) importPath(spec,pos); else if (tier!==undefined) report(pos,'unresolved tier import');
        }
        if (/(?:^|\.)token(?:\.var)?$/.test(callee)) reference(literal(n.arguments[0]),tokens,pos);
        if (/(?:^|\.)(setTimeout|setInterval)$/.test(callee) || /\.style\.setProperty$/.test(callee)) value(literal(n.arguments[1]),pos);
        if (callee.endsWith('.setAttribute')) {
          const attr=literal(n.arguments[0]), raw=literal(n.arguments[1]);
          if (attr==='style') declarations(raw,pos); else if (property(attr)) value(raw,pos);
        }
      }
      if (ts.isJsxElement(n) && n.openingElement.tagName.getText(tree)==='style') {
        for (const child of n.children) declarations(ts.isJsxText(child)?child.text:literal(child),pos);
      }
      if (ts.isTaggedTemplateExpression(n)) declarations(literal(n.template),pos);
      if (ts.isVariableDeclaration(n) && n.initializer && /^(?:css|styles?|stylesheet)$/i.test(n.name.getText(tree))) declarations(literal(n.initializer),pos);
      ts.forEachChild(n,inspect);
    }
    inspect(tree);
  }
  for (const issue of reasons) console.error(issue);
  if (reasons.size) process.exitCode=1;
  else console.log('Tier source checks passed (' + files.length + ' tracked files).');
}
main().catch(error => { console.error(error.message); process.exitCode=2; });
