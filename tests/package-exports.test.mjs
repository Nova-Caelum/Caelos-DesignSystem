import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(root, "package.json");
const expectedExports = {
  ".": "./generated/components/index.ts",
  "./components": "./generated/components/index.ts",
  "./tailwind-theme.css": "./generated/tailwind-theme.css",
  "./tokens.css": "./generated/tokens.css",
};

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function packageFiles() {
  const packRoot = mkdtempSync(resolve(tmpdir(), "caelos-package-pack-"));
  const packageJson = {
    ...readPackageJson(),
    version: "0.0.0-test",
    scripts: {},
  };

  try {
    writeFileSync(resolve(packRoot, "package.json"), JSON.stringify(packageJson));
    cpSync(resolve(root, "generated"), resolve(packRoot, "generated"), { recursive: true });

    const output = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: packRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: resolve(packRoot, ".npm-cache") },
      },
    );
    return JSON.parse(output)[0].files.map(({ path }) => path);
  } finally {
    rmSync(packRoot, { force: true, recursive: true });
  }
}

test("every public export targets an existing package file", () => {
  const packageJson = readPackageJson();

  assert.deepEqual(packageJson.exports, expectedExports);
  for (const target of Object.values(packageJson.exports)) {
    assert.ok(target.startsWith("./"), `export target ${target} must start with ./ (Node package exports rule)`);
  }

  for (const target of Object.values(expectedExports)) {
    const absoluteTarget = resolve(root, target);
    assert.equal(relative(root, absoluteTarget).startsWith(".."), false);
    assert.equal(existsSync(absoluteTarget), true, `${target} must exist`);
  }
});

test("package files include all public export targets", () => {
  const packageJson = readPackageJson();

  assert.equal(packageJson.private, true);
  assert.ok(packageJson.files.includes("generated/"));
});

test("npm pack includes every public export target", () => {
  const packedFiles = packageFiles();

  for (const target of new Set(Object.values(expectedExports))) {
    const packedPath = target.replace(/^\.\//, "");
    assert.ok(packedFiles.includes(packedPath), `${target} is missing from npm pack`);
  }
});
