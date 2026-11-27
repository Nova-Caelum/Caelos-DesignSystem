export const requiredFields = ["kind", "layerOrder", "variants.variant", "defaultVariants.variant", "states", "statePaints"];
export const interactiveElement = 'button';

const quote = (value) => JSON.stringify(value);
const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function nestedLayers(layerOrder, entry, variantExpression, content) {
  let result = content;
  for (const layer of [...layerOrder].reverse()) {
    result = `<span data-entry=${quote(entry)} data-variant={${variantExpression}} data-layer=${quote(layer)}>\n${result}\n</span>`;
  }
  return result;
}

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function union(values) {
  return values.map(quote).join(' | ');
}

function paintDeclarations(paint, variable) {
  return Object.entries(paint)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([field, reference]) => {
      const property = field === 'foreground' ? 'color'
        : field === 'fill' ? 'background-color'
          : `--caelos-paint-${field.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`;
      return `  ${property}: ${variable(reference)};`;
    })
    .join('\n');
}

function selectors(className, variant, state) {
  const attribute = `.${className}[data-variant=${quote(variant)}][data-state=${quote(state)}]`;
  const automatic = {
    hover: `.${className}[data-variant=${quote(variant)}]:hover:not(:disabled)`,
    pressed: `.${className}[data-variant=${quote(variant)}]:active:not(:disabled)`,
    focus: `.${className}[data-variant=${quote(variant)}]:focus-visible`,
    disabled: `.${className}[data-variant=${quote(variant)}]:disabled`,
  }[state];
  return automatic ? `${attribute},\n${automatic}` : attribute;
}

function paintRule(selector, paint, variable) {
  return `${selector} {\n${paintDeclarations(paint, variable)}\n}`;
}

function renderPaint({ className, record, variable }) {
  const rules = [];
  for (const variant of record.variants.variant) {
    rules.push(paintRule(
      `.${className}[data-variant=${quote(variant)}]`,
      record.statePaints[variant].default,
      variable,
    ));
    for (const state of record.states) {
      rules.push(paintRule(selectors(className, variant, state), record.statePaints[variant][state], variable));
    }
  }
  return rules.join('\n\n');
}

export function validate({ tier, record }) {
  if (tier > 2) return null;
  const variants = record.variants.variant;
  if (!variants.includes(record.defaultVariants.variant)) {
    return {
      field: 'defaultVariants.variant',
      reason: `defaultVariants.variant names unknown variant ${quote(record.defaultVariants.variant)}`,
    };
  }
  for (const variant of variants) {
    if (!record.statePaints[variant] || typeof record.statePaints[variant] !== 'object') {
      const field = `statePaints.${variant}`;
      return { field, reason: `missing required field ${quote(field)}` };
    }
    for (const state of record.states) {
      const paint = record.statePaints[variant][state];
      if (!paint || typeof paint !== 'object' || Array.isArray(paint) || Object.keys(paint).length === 0) {
        const field = `statePaints.${variant}.${state}`;
        return { field, reason: `missing or empty required field ${quote(field)}` };
      }
    }
  }
  return null;
}

function renderControl(model) {
  const { className, componentName, name, record } = model;
  const variants = record.variants.variant;
  const states = record.states;
  const layers = nestedLayers(
    record.layerOrder,
    name,
    'variant',
    "{layers?.[" + quote(record.layerOrder.at(-1)) + '] ?? children}',
  );
  const source = `import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import './${componentName}.css';

export type ${componentName}Variant = ${union(variants)};
export type ${componentName}State = ${union(states)};
export type ${componentName}Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children?: ReactNode;
  layers?: Partial<Record<string, ReactNode>>;
  variant?: ${union(variants)};
  state?: ${union(states)};
};

export function ${componentName}({
  children,
  layers,
  onKeyDown,
  state = 'default',
  variant = ${quote(record.defaultVariants.variant)},
  ...props
}: ${componentName}Props) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') event.currentTarget.blur();
    onKeyDown?.(event);
  };

  return (
    <button
      {...props}
      className={[${quote(className)}, props.className].filter(Boolean).join(' ')}
      data-entry=${quote(name)}
      data-state={props.disabled ? 'disabled' : state}
      data-variant={variant}
      onKeyDown={handleKeyDown}
    >
${indent(layers, 6)}
    </button>
  );
}
`;
  const paint = renderPaint(model);
  return { tsx: source, css: `/* Generated token references for ${name}. */\n${paint}\n` };
}

function renderComposition({ componentName, name, parts, record }) {
  const variants = record.variants.variant;
  const imports = parts
    .map((part) => `import { ${part.componentName} } from './${part.componentName}';`)
    .join('\n');
  const tree = [
    ...parts.map((part) => `<${part.componentName} variant={variant} />`),
    '{children}',
  ].join('\n');
  return {
    tsx: `import type { ButtonHTMLAttributes, ReactNode } from 'react';
${imports}
import './${componentName}.css';

export type ${componentName}Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children?: ReactNode;
  variant?: ${union(variants)};
};

export function ${componentName}({ children, variant = ${quote(record.defaultVariants.variant)}, ...props }: ${componentName}Props) {
  return (
    <button {...props} data-entry=${quote(name)} data-variant={variant}>
${indent(tree, 6)}
    </button>
  );
}
`,
    css: `/* ${name} composes lower-tier parts and owns no paint. */\n`,
  };
}

export function render(model) {
  if (model.tier > 2) return renderComposition(model);
  return renderControl(model);
}
