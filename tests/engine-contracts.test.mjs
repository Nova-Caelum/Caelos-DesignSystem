import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests/fixtures/engine-contracts");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validate(schema, value, location = "$", rootSchema = schema) {
  if (schema.$ref) {
    assert.match(schema.$ref, /^#\//, "only local schema references are supported");
    const target = schema.$ref
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((current, part) => current[part], rootSchema);
    return validate(target, value, location, rootSchema);
  }

  if (schema.oneOf) {
    const results = schema.oneOf.map((branch) =>
      validate(branch, value, location, rootSchema),
    );
    const passing = results.filter((errors) => errors.length === 0);
    if (passing.length === 1) return [];
    return [
      `${location} must match exactly one allowed shape`,
      ...results.flat(),
    ];
  }

  const errors = [];
  if (Object.hasOwn(schema, "const") && !equalJson(value, schema.const)) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((item) => equalJson(value, item))) {
    errors.push(`${location} must be one of ${schema.enum.map(JSON.stringify).join(", ")}`);
  }

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [...errors, `${location} must be an object`];
    }
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) errors.push(`${location}.${name} is required`);
    }
    for (const [name, item] of Object.entries(value)) {
      const propertySchema = schema.properties?.[name];
      if (!propertySchema && schema.additionalProperties === false) {
        errors.push(`${location}.${name} is not allowed`);
      } else if (propertySchema) {
        errors.push(...validate(propertySchema, item, `${location}.${name}`, rootSchema));
      }
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${location} must have at least ${schema.minProperties} properties`);
    }
    if (schema["x-caelos-unique-step-names"] === true && Array.isArray(value.steps)) {
      const names = value.steps.map((step) => step.step);
      if (new Set(names).size !== names.length) errors.push(`${location}.steps has duplicate step names`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [...errors, `${location} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} items`);
    }
    if (schema.uniqueItems && new Set(value.map(JSON.stringify)).size !== value.length) {
      errors.push(`${location} must contain unique items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validate(schema.items, item, `${location}[${index}]`, rootSchema));
      });
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return [...errors, `${location} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${location} must contain at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${location} does not match ${schema.pattern}`);
    }
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) return [...errors, `${location} must be an integer`];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${location} is above maximum`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${location} must be a boolean`);
  }
  return errors;
}

const contractCases = [
  ["craft", "triggers"],
  ["match", "confidence"],
  ["integrate", "rawColor"],
  ["assemble", "source"],
];

test("each contract accepts its good fixture and refuses its bad fixture by field", async (t) => {
  for (const [name, badField] of contractCases) {
    await t.test(name, () => {
      const schema = readJson(`engine/contracts/${name}.schema.json`);
      const good = readJson(`tests/fixtures/engine-contracts/${name}/good.json`);
      const bad = readJson(`tests/fixtures/engine-contracts/${name}/bad.json`);
      assert.deepEqual(validate(schema, good), []);
      const errors = validate(schema, bad);
      assert.ok(errors.length > 0, `${name} bad fixture unexpectedly passed`);
      assert.match(errors.join("\n"), new RegExp(badField, "u"));
    });
  }
});

test("craft permits a plain wireframe container", () => {
  const schema = readJson("engine/contracts/craft.schema.json");
  assert.ok(schema.properties.container.enum.includes("plain"));
});

test("integrate recipe fields come exactly from the recipe schema", () => {
  const integrate = readJson("engine/contracts/integrate.schema.json");
  const recipe = readJson("token_catalog/recipe.schema.json");
  assert.deepEqual(
    Object.keys(integrate.$defs.recipe.properties).sort(),
    Object.keys(recipe.properties).sort(),
  );
});

test("integrate instructions preserve gap and draft rules", () => {
  const instructions = readFileSync(path.join(root, "engine/contracts/integrate.instructions.md"), "utf8");
  assert.match(instructions, /reference value[^\n]*draft/iu);
  assert.match(instructions, /nearest[^\n]*flag/iu);
  assert.match(instructions, /marked placeholder/iu);
  assert.match(instructions, /never stop/iu);
  assert.match(instructions, /two drafts/iu);
  assert.match(instructions, /existing entry/iu);
  assert.match(instructions, /lifecycle[^\n]*draft/iu);
  assert.match(instructions, /draftedBy[^\n]*job id/iu);
  assert.match(instructions, /gapFill/iu);
  assert.match(instructions, /do not (?:write|create)[^\n]*template/iu);
});

const chainOrders = {
  apply: ["craft", "match", "integrate", "generate", "assemble", "count-handlers", "finish"],
  expand: ["craft", "match", "integrate", "generate", "finish"],
  assemble: ["match", "integrate", "generate", "copy-contract-kit", "assemble", "count-handlers", "finish"],
  creative: ["craft", "match", "integrate", "generate", "assemble", "count-handlers", "finish"],
};

test("every chain validates and each job chain has its required order", async (t) => {
  const schema = readJson("engine/chain.schema.json");
  const names = readdirSync(path.join(root, "engine/chains"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".chain.json"))
    .map((entry) => entry.name.replace(/\.chain\.json$/u, ""))
    .sort();
  for (const name of names) {
    await t.test(name, () => {
      const chain = readJson(`engine/chains/${name}.chain.json`);
      assert.deepEqual(validate(schema, chain), []);
      if (chainOrders[name]) {
        assert.deepEqual(chain.steps.map((step) => step.step), chainOrders[name]);
      }
    });
  }
  assert.deepEqual(
    Object.keys(chainOrders).filter((name) => !names.includes(name)),
    [],
    "a required job chain is missing",
  );
});

test("job-specific chain boundaries are explicit", () => {
  const apply = readJson("engine/chains/apply.chain.json");
  const expand = readJson("engine/chains/expand.chain.json");
  const assemble = readJson("engine/chains/assemble.chain.json");
  const creative = readJson("engine/chains/creative.chain.json");
  assert.equal(apply.steps.some((step) => step.inputs.includes("backend-contract")), false);
  assert.equal(expand.steps.some((step) => step.step === "assemble"), false);
  assert.deepEqual(assemble.steps[0].inputs, ["wireframe.json"]);
  assert.ok(assemble.steps.find((step) => step.step === "copy-contract-kit").inputs.includes("backend-contract"));
  assert.ok(creative.steps[0].inputs.includes("brief.md"));
});

test("engine contains no internal workspace path", () => {
  const pattern = [
    ["Agent", "SecretBase"].join(""),
    ["Nova", "Caelum_Obs"].join(""),
  ].join("|");
  const result = spawnSync("grep", ["-rE", pattern, "engine/"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stdout || result.stderr);
});
