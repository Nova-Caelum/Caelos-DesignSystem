#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

class InputError extends Error {
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
      throw new InputError("arguments are invalid", "use --screen <source file> --list <behaviours.json>");
    }
    if (values[flag]) throw new InputError(`${flag} is repeated`, `pass ${flag} exactly once`);
    values[flag] = value;
  }
  for (const flag of allowed) {
    if (!values[flag]) throw new InputError(`${flag} is missing`, `pass ${flag} with its file path`);
  }
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

function firstCall(node) {
  if (ts.isCallExpression(node)) return node;
  let found;
  ts.forEachChild(node, (child) => {
    if (!found) found = firstCall(child);
  });
  return found;
}

function expressionHandler(expression, attribute, sourceFile) {
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    return expression.getText(sourceFile);
  }
  if (ts.isCallExpression(expression)) return expression.expression.getText(sourceFile);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const call = firstCall(expression.body);
    if (call) {
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "bind") {
        return call.expression.expression.getText(sourceFile);
      }
      return call.expression.getText(sourceFile);
    }
  }
  const position = sourceFile.getLineAndCharacterOfPosition(attribute.getStart(sourceFile));
  return `inline:${attribute.name.getText(sourceFile)}@${position.line + 1}:${position.character + 1}`;
}

export function findActionHandlers(source, fileName = "screen.tsx") {
  const extension = path.extname(fileName).toLowerCase();
  if (![".jsx", ".tsx"].includes(extension)) {
    throw new InputError(`screen '${fileName}' is not JSX or TSX`, "pass the React screen's .jsx or .tsx source file");
  }
  const kind = extension === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    throw new InputError(`screen '${fileName}' is invalid JSX: ${message}`, "fix the source syntax and rerun the handler check");
  }

  const handlers = [];
  function visit(node) {
    if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(sourceFile))) {
      const expression = node.initializer && ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : undefined;
      if (expression) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        handlers.push({
          handler: expressionHandler(expression, node, sourceFile),
          prop: node.name.getText(sourceFile),
          line: position.line + 1,
          column: position.character + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return handlers;
}

function parseList(source, file) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new InputError(`list '${file}' is invalid JSON: ${error.message}`, "fix it against behaviours.schema.json");
  }
  if (!value || !Array.isArray(value.lines)) {
    throw new InputError(`list '${file}' has no lines array`, "add the screen's behaviour lines");
  }
  for (const [index, line] of value.lines.entries()) {
    if (!line || !(line.handler === null || typeof line.handler === "string")) {
      throw new InputError(`list '${file}' line ${index + 1} has an invalid handler`, "use a source handler name or null");
    }
  }
  return value;
}

export function compareHandlers(handlers, list) {
  const listed = new Set(list.lines.map((line) => line.handler).filter(Boolean));
  const present = new Set(handlers.map((entry) => entry.handler));
  return {
    missing: [...present].filter((handler) => !listed.has(handler)).sort(),
    extra: [...listed].filter((handler) => !present.has(handler)).sort(),
  };
}

export async function checkHandlers({ screen, list }) {
  const source = await readRegularFile(screen, "screen source");
  const listSource = await readRegularFile(list, "behaviour list");
  const handlers = findActionHandlers(source, screen);
  const behaviourList = parseList(listSource, list);
  return { handlers, ...compareHandlers(handlers, behaviourList) };
}

export async function runCli(argv, io = console) {
  try {
    const options = parseArguments(argv);
    const result = await checkHandlers(options);
    if (result.extra.length > 0) {
      io.warn(`Warning: list handlers not present in the screen source: ${result.extra.join(", ")}. Remove or update those stale handler names.`);
    }
    if (result.missing.length > 0) {
      const locations = result.missing.map((name) => {
        const entries = result.handlers.filter((entry) => entry.handler === name);
        return `${name} (${entries.map((entry) => `${entry.prop} at ${entry.line}:${entry.column}`).join(", ")})`;
      });
      io.error(`Handler check refused: ${locations.join("; ")} present in the screen source but absent from the behaviour list. Next: add one behaviour line for every named handler.`);
      return 1;
    }
    io.log(`Handler check passed: ${result.handlers.length} JSX action props are covered by the behaviour list.`);
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
