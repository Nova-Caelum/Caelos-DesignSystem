export const requiredFields = ["kind", "layerOrder"];

const quote = (value) => JSON.stringify(value);

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

function renderPaint({ className, variables }) {
  const states = [
    ['', 'foreground'],
    [':hover', 'hoverForeground'],
    [':focus-visible', 'focusForeground'],
    [':active', 'pressedForeground'],
  ];
  return states
    .filter(([, token]) => variables[token])
    .map(([selector, token]) => `.${className}${selector} {\n  color: ${variables[token]};\n}`)
    .join('\n\n');
}

function renderControl(model) {
  const { className, componentName, name, record } = model;
  const layers = nestedLayers(
    record.layerOrder,
    name,
    'variant',
    "{layers?.[" + quote(record.layerOrder.at(-1)) + '] ?? children}',
  );
  const source = `import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import './${componentName}.css';

export type ${componentName}Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children?: ReactNode;
  layers?: Partial<Record<string, ReactNode>>;
  variant?: string;
};

export function ${componentName}({
  children,
  layers,
  onKeyDown,
  variant = 'default',
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
      data-variant={variant}
      onKeyDown={handleKeyDown}
    >
${indent(layers, 6)}
    </button>
  );
}
`;
  const paint = renderPaint(model);
  const css = `/* Generated token references for ${name}. */\n${paint}${paint ? '\n' : ''}`;
  return { tsx: source, css };
}

function renderComposition({ componentName, name, parts }) {
  const imports = parts
    .map((part) => `import { ${part.componentName} } from './${part.componentName}';`)
    .join('\n');
  let tree = '{children}';
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const props = index === 0 ? ' {...props}' : '';
    tree = `<${part.componentName}${props} data-entry=${quote(name)} data-variant={variant}>\n${tree}\n</${part.componentName}>`;
  }
  const outerName = parts[0].componentName;
  return {
    tsx: `import type { ComponentProps, ReactNode } from 'react';
${imports}
import './${componentName}.css';

export type ${componentName}Props = ComponentProps<typeof ${outerName}> & {
  children?: ReactNode;
  variant?: string;
};

export function ${componentName}({ children, variant = 'default', ...props }: ${componentName}Props) {
  return (
${indent(tree, 4)}
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
