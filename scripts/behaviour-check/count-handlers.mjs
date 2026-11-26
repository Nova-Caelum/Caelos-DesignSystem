#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ACTION_STEPS = new Set(["click", "type", "press", "focus"]);
const CLICK_PROPS = new Set([
  "onClick", "onDoubleClick", "onMouseDown", "onMouseUp", "onPointerDown",
  "onPointerUp", "onContextMenu", "onAuxClick",
]);
const CHANGE_PROPS = new Set(["onChange", "onInput", "onBeforeInput"]);
const KEY_PROPS = new Set(["onKeyDown", "onKeyUp", "onKeyPress"]);

export class InputError extends Error {
  constructor(reason, next) {
    super(reason);
    this.next = next;
  }
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(["--screen", "--list"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw new InputError("arguments are invalid", "use --list <behaviours.json> and optionally --screen <source file>");
    }
    if (values[flag]) throw new InputError(`${flag} is repeated`, `pass ${flag} at most once`);
    values[flag] = value;
  }
  if (!values["--list"]) throw new InputError("--list is missing", "pass --list with its file path");
  return { screen: values["--screen"], list: values["--list"] };
}

async function readRegularFile(file, label) {
  try {
    const details = await stat(file);
    if (!details.isFile()) throw new Error("path is not a regular file");
    return await readFile(file, "utf8");
  } catch (error) {
    throw new InputError(`${label} '${file}' is unavailable: ${error.message}`, `pass a readable ${label} file`);
  }
}

function validateComponentRoles(componentRoles, label) {
  if (componentRoles === undefined) return {};
  if (!componentRoles || typeof componentRoles !== "object" || Array.isArray(componentRoles)) {
    throw new InputError(`${label} has invalid componentRoles`, "use an object mapping component tags to non-empty role strings");
  }
  for (const [tag, role] of Object.entries(componentRoles)) {
    if (!tag || typeof role !== "string" || role.length === 0) {
      throw new InputError(`${label} has invalid componentRoles`, "map each component tag to a non-empty role string");
    }
  }
  return componentRoles;
}

function validateList(value, file = "behaviour list") {
  const label = `list '${file}'`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(`${label} is not an object`, "fix it against behaviours.schema.json");
  }
  if (typeof value.screen !== "string" || value.screen.length === 0) {
    throw new InputError(`${label} has an invalid screen`, "name the screen source relative to the list file");
  }
  validateComponentRoles(value.componentRoles, label);
  if (!Array.isArray(value.lines)) {
    throw new InputError(`${label} has no lines array`, "add the screen's behaviour lines");
  }
  for (const [index, line] of value.lines.entries()) {
    const lineLabel = `${label} line ${index + 1}`;
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw new InputError(`${lineLabel} is invalid`, "use a behaviour line object");
    }
    if (typeof line.id !== "string" || line.id.length === 0) {
      throw new InputError(`${lineLabel} has an invalid id`, "give every line a non-empty id");
    }
    if (!(line.handler === null || typeof line.handler === "string")) {
      throw new InputError(`${lineLabel} has an invalid handler`, "use a source handler name or null");
    }
    if (!Array.isArray(line.steps)) {
      throw new InputError(`${lineLabel} has invalid steps`, "use an array of behaviour steps");
    }
    for (const [stepIndex, step] of line.steps.entries()) {
      if (!step || typeof step !== "object" || Array.isArray(step) || typeof step.do !== "string") {
        throw new InputError(`${lineLabel} step ${stepIndex + 1} is invalid`, "use a step object with a do string");
      }
      if (ACTION_STEPS.has(step.do) && (typeof step.role !== "string" || typeof step.name !== "string")) {
        throw new InputError(`${lineLabel} step ${stepIndex + 1} has an invalid target`, "give action steps string role and name values");
      }
    }
    if (line.covers !== undefined) {
      if (!Array.isArray(line.covers)) {
        throw new InputError(`${lineLabel} has invalid covers`, "use an array of { prop, at } objects");
      }
      for (const [coverIndex, cover] of line.covers.entries()) {
        if (!cover || typeof cover !== "object" || Array.isArray(cover)
          || typeof cover.prop !== "string" || cover.prop.length === 0
          || typeof cover.at !== "string" || !/^[1-9]\d*:[1-9]\d*$/.test(cover.at)) {
          throw new InputError(`${lineLabel} cover ${coverIndex + 1} is invalid`, "use { \"prop\": string, \"at\": \"<line>:<column>\" }");
        }
      }
    }
  }
  return value;
}

function parseList(source, file) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new InputError(`list '${file}' is invalid JSON: ${error.message}`, "fix it against behaviours.schema.json");
  }
  return validateList(value, file);
}

function positionAt(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const line = position.line + 1;
  const column = position.character + 1;
  return { line, column, at: `${line}:${column}` };
}

function staticString(attribute) {
  const initializer = attribute?.initializer;
  if (initializer && ts.isStringLiteral(initializer)) return initializer.text;
  if (initializer && ts.isJsxExpression(initializer) && initializer.expression
    && (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression))) {
    return initializer.expression.text;
  }
  return null;
}

function attributesByName(opening, sourceFile) {
  const result = new Map();
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxAttribute(attribute)) result.set(attribute.name.getText(sourceFile), attribute);
  }
  return result;
}

function intrinsicRole(tag, attributes) {
  if (tag === "button") return "button";
  if ((tag === "a" || tag === "area") && attributes.has("href")) return "link";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return attributes.has("multiple") ? "listbox" : "combobox";
  if (tag === "option") return "option";
  if (tag !== "input") return null;

  const typeAttribute = attributes.get("type");
  const type = typeAttribute ? staticString(typeAttribute) : "text";
  if (type === null) return null;
  switch (type.toLowerCase()) {
    case "":
    case "text":
    case "email":
    case "tel":
    case "url": return "textbox";
    case "search": return "searchbox";
    case "checkbox": return "checkbox";
    case "radio": return "radio";
    case "range": return "slider";
    case "number": return "spinbutton";
    case "button":
    case "submit":
    case "reset":
    case "image": return "button";
    default: return null;
  }
}

function elementRole(tag, attributes, componentRoles) {
  if (attributes.has("role")) return staticString(attributes.get("role"));
  if (/^[A-Z]/.test(tag) || tag.includes(".")) {
    const mapped = componentRoles[tag];
    return typeof mapped === "string" && mapped.length > 0 ? mapped : null;
  }
  return intrinsicRole(tag, attributes);
}

function descendantText(children) {
  let text = "";
  let dynamic = false;
  function collect(nodes) {
    for (const child of nodes) {
      if (ts.isJsxText(child)) text += child.text;
      else if (ts.isJsxExpression(child)) {
        if (child.expression) dynamic = true;
      } else if (ts.isJsxElement(child) || ts.isJsxFragment(child)) collect(child.children);
    }
  }
  collect(children);
  if (dynamic) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function elementName(element, attributes, sourceFile) {
  if (attributes.has("aria-label")) {
    const label = staticString(attributes.get("aria-label"));
    return label === null ? null : label.replace(/\s+/g, " ").trim();
  }
  if (attributes.has("aria-labelledby")) return null;
  const tag = element.tagName.getText(sourceFile);
  if (["input", "textarea", "select"].includes(tag)) return null;
  if (ts.isJsxSelfClosingElement(element)) return null;
  return descendantText(element.parent.children);
}

function expressionHandler(expression, sourceFile) {
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) return expression.getText(sourceFile);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === "bind"
    && (ts.isIdentifier(expression.expression.expression) || ts.isPropertyAccessExpression(expression.expression.expression))) {
    return expression.expression.expression.getText(sourceFile);
  }
  return "inline";
}

export function findActionHandlers(source, fileName = "screen.tsx", { componentRoles = {} } = {}) {
  const extension = path.extname(fileName).toLowerCase();
  if (![".jsx", ".tsx"].includes(extension)) {
    throw new InputError(`screen '${fileName}' is not JSX or TSX`, "pass the React screen's .jsx or .tsx source file");
  }
  validateComponentRoles(componentRoles, `screen '${fileName}' options`);
  const kind = extension === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    throw new InputError(`screen '${fileName}' is invalid JSX: ${message}`, "fix the source syntax and rerun the handler check");
  }

  const entries = [];
  function inspectElement(element) {
    const tag = element.tagName.getText(sourceFile);
    const attributes = attributesByName(element, sourceFile);
    const tagPosition = positionAt(sourceFile, element.tagName);
    const sharedElement = {
      tag,
      at: tagPosition.at,
      role: elementRole(tag, attributes, componentRoles),
      name: elementName(element, attributes, sourceFile),
    };
    for (const attribute of element.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attribute)) {
        entries.push({ prop: "{...}", handler: "spread", ...positionAt(sourceFile, attribute), element: { ...sharedElement } });
        continue;
      }
      const prop = attribute.name.getText(sourceFile);
      if (!/^on[A-Z]/.test(prop)) continue;
      const expression = attribute.initializer && ts.isJsxExpression(attribute.initializer)
        ? attribute.initializer.expression : undefined;
      if (!expression) continue;
      entries.push({ prop, handler: expressionHandler(expression, sourceFile), ...positionAt(sourceFile, attribute), element: { ...sharedElement } });
    }
  }
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) inspectElement(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const identitiesByTarget = new Map();
  for (const entry of entries) {
    const { role, name, at } = entry.element;
    if (role === null || name === null) continue;
    const key = JSON.stringify([role, name]);
    if (!identitiesByTarget.has(key)) identitiesByTarget.set(key, new Set());
    identitiesByTarget.get(key).add(at);
  }
  for (const entry of entries) {
    const { role, name } = entry.element;
    const ambiguous = role !== null && name !== null
      && identitiesByTarget.get(JSON.stringify([role, name]))?.size > 1;
    if (entry.prop === "{...}") entry.reason = "spread";
    else if (role === null) entry.reason = "role unknown";
    else if (name === null) entry.reason = "name unknown";
    else if (ambiguous) entry.reason = "ambiguous";
    entry.tied = entry.reason === undefined;
  }
  return entries;
}

// Only the steps whose browser action dispatches the prop's event count:
// "type" fills the field (input events, no key events), "press" sends keys,
// "click" sends pointer events and toggles checkable controls.
const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch"]);

function allowedSteps(prop, role) {
  const normalized = prop.endsWith("Capture") ? prop.slice(0, -"Capture".length) : prop;
  if (CLICK_PROPS.has(normalized)) return ["click"];
  if (CHANGE_PROPS.has(normalized)) return CHECKABLE_ROLES.has(role) ? ["click"] : ["type"];
  if (KEY_PROPS.has(normalized)) return ["press"];
  if (normalized === "onFocus") return ["focus", "click"];
  return [...ACTION_STEPS];
}

function actionSteps(line) {
  return line.steps.filter((step) => ACTION_STEPS.has(step.do));
}

export function compareHandlers(entries, list) {
  validateList(list);
  const coveredEntries = new Set();
  const declaredEntries = new Set();
  const problems = [];
  for (const line of list.lines) {
    const actions = actionSteps(line);
    const exercisedByLine = new Set();
    for (const entry of entries) {
      if (!entry.tied) continue;
      const allowed = new Set(allowedSteps(entry.prop, entry.element.role));
      if (actions.some((step) => step.role === entry.element.role
        && step.name === entry.element.name && allowed.has(step.do))) {
        coveredEntries.add(entry);
        exercisedByLine.add(entry);
      }
    }
    for (const cover of line.covers ?? []) {
      const entry = entries.find((candidate) => candidate.prop === cover.prop && candidate.at === cover.at);
      if (!entry) {
        problems.push(`line '${line.id}' declares ${cover.prop} at ${cover.at}, which is not in the screen source`);
      } else if (entry.tied) {
        problems.push(`line '${line.id}' declares ${cover.prop} at ${cover.at}, which is tied to ${entry.element.role} '${entry.element.name}'; cover it with a step on that element instead`);
      } else if (actions.length === 0) {
        problems.push(`line '${line.id}' declares ${cover.prop} at ${cover.at} but has no action step`);
      } else {
        declaredEntries.add(entry);
        exercisedByLine.add(entry);
      }
    }
    if (line.handler !== null && ![...exercisedByLine].some((entry) => entry.handler === line.handler)) {
      problems.push(`line '${line.id}' names handler '${line.handler}' but exercises no element carrying it`);
    }
  }
  return {
    covered: entries.filter((entry) => coveredEntries.has(entry)),
    declared: entries.filter((entry) => declaredEntries.has(entry)),
    missing: entries.filter((entry) => !coveredEntries.has(entry) && !declaredEntries.has(entry)),
    problems,
  };
}

export function resolveScreen(listFile, list) {
  validateList(list, listFile);
  return path.resolve(path.dirname(path.resolve(listFile)), list.screen);
}

export async function checkListCoverage({ listFile, list }) {
  validateList(list, listFile);
  const screen = resolveScreen(listFile, list);
  const source = await readRegularFile(screen, "screen source");
  const entries = findActionHandlers(source, screen, { componentRoles: list.componentRoles });
  return { entries, ...compareHandlers(entries, list) };
}

export async function checkHandlers({ screen, list }) {
  const listSource = await readRegularFile(list, "behaviour list");
  const behaviourList = parseList(listSource, list);
  const screenFile = screen ? path.resolve(screen) : resolveScreen(list, behaviourList);
  const source = await readRegularFile(screenFile, "screen source");
  const entries = findActionHandlers(source, screenFile, { componentRoles: behaviourList.componentRoles });
  return { entries, ...compareHandlers(entries, behaviourList) };
}

function coverageDescription(entry) {
  return `${entry.prop} at ${entry.at} on ${entry.element.tag} (${entry.element.role ?? "role unknown"} '${entry.element.name ?? "name unknown"}', handler ${entry.handler})`;
}

function coverageHint(entry) {
  if (entry.tied) return `add a line with a ${allowedSteps(entry.prop, entry.element.role).join("/")} step on ${entry.element.role} '${entry.element.name}'`;
  const declare = `declare {"prop":"${entry.prop}","at":"${entry.at}"} in the covers of the line that exercises it`;
  if (entry.reason === "spread") return `spread: the handlers it passes cannot be seen; pass them as named props, or ${declare}`;
  if (entry.reason === "ambiguous") return `ambiguous: give each element a distinct accessible name, or ${declare}`;
  return `${entry.reason}: add componentRoles for ${entry.element.tag}, give it a static aria-label, or declare {"prop":"${entry.prop}","at":"${entry.at}"} in the covers of the line that exercises it`;
}

export function formatCoverageRefusal(result) {
  const details = result.missing.map((entry) => `${coverageDescription(entry)} — ${coverageHint(entry)}`);
  details.push(...result.problems);
  return details.join("; ");
}

export async function runCli(argv, io = console) {
  try {
    const options = parseArguments(argv);
    const result = await checkHandlers(options);
    const listSource = await readRegularFile(options.list, "behaviour list");
    const behaviourList = parseList(listSource, options.list);
    const labels = new Set(result.entries.map((entry) => entry.handler));
    const stale = behaviourList.lines.map((line) => line.handler)
      .filter((handler) => handler !== null && !labels.has(handler));
    if (stale.length > 0) {
      io.warn(`Warning: list handlers not present in the screen source: ${[...new Set(stale)].join(", ")}. Remove or update those stale handler names.`);
    }
    if (result.missing.length > 0 || result.problems.length > 0) {
      io.error(`Handler check refused: ${formatCoverageRefusal(result)} Next: address every missing occurrence and problem, then rerun the handler check.`);
      return 1;
    }
    const elements = new Set(result.entries.map((entry) => entry.element.at)).size;
    io.log(`Handler check passed: ${result.entries.length} handler props on ${elements} elements covered; ${result.declared.length} declared, not statically tied.`);
    return 0;
  } catch (error) {
    if (error instanceof InputError) {
      io.error(`Handler check could not run: ${error.message}. Next: ${error.next}.`);
      return 2;
    }
    io.error(`Handler check could not run: ${error instanceof Error ? error.message : String(error)}. Next: fix the named error and rerun the check.`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
