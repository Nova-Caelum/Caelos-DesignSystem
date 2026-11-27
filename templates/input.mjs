export const requiredFields = ["kind", "layerOrder", "variants.variant", "defaultVariants.variant", "states", "statePaints"];
export const interactiveElement = "textarea";

const quote = (value) => JSON.stringify(value);
const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const union = (values) => values.map(quote).join(" | ");

function paintDeclarations(paint, variable) {
  return Object.entries(paint)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([field, reference]) => {
      const property = field === "foreground" ? "color"
        : field === "fill" ? "background-color"
          : `--caelos-paint-${field.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase()}`;
      return `  ${property}: ${variable(reference)};`;
    })
    .join("\n");
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

export function validate({ tier, record }) {
  if (tier > 2) return null;
  if (!record.variants.variant.includes(record.defaultVariants.variant)) {
    return {
      field: "defaultVariants.variant",
      reason: `defaultVariants.variant names unknown variant ${quote(record.defaultVariants.variant)}`,
    };
  }
  for (const variant of record.variants.variant) {
    for (const state of ["default", ...record.states]) {
      const paint = record.statePaints?.[variant]?.[state];
      if (!paint || typeof paint !== "object" || Array.isArray(paint) || Object.keys(paint).length === 0) {
        const field = `statePaints.${variant}.${state}`;
        return { field, reason: `missing or empty required field ${quote(field)}` };
      }
    }
  }
  return null;
}

export function render({ className, componentName, name, record, variable }) {
  const variants = record.variants.variant;
  const states = record.states;
  const rules = [];
  for (const variant of variants) {
    rules.push(paintRule(
      `.${className}[data-variant=${quote(variant)}]`,
      record.statePaints[variant].default,
      variable,
    ));
    for (const state of states) {
      rules.push(paintRule(selectors(className, variant, state), record.statePaints[variant][state], variable));
    }
  }
  return {
    tsx: `import type { KeyboardEvent, TextareaHTMLAttributes } from 'react';
import './${componentName}.css';

export type ${componentName}Variant = ${union(variants)};
export type ${componentName}State = ${union(["default", ...states])};
export type ${componentName}Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSubmit'> & {
  onSubmit?: (value: string) => void;
  variant?: ${componentName}Variant;
  state?: ${componentName}State;
};

export function ${componentName}({
  onKeyDown,
  onSubmit,
  state = 'default',
  variant = ${quote(record.defaultVariants.variant)},
  ...props
}: ${componentName}Props) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') event.currentTarget.blur();
    if (onSubmit && event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!props.disabled && !props.readOnly) onSubmit(event.currentTarget.value);
    }
  };

  return (
    <textarea
      {...props}
      className={[${quote(className)}, props.className].filter(Boolean).join(' ')}
      data-entry=${quote(name)}
      data-layer-order=${quote(record.layerOrder.join(" "))}
      data-state={props.disabled ? 'disabled' : state}
      data-variant={variant}
      aria-invalid={state === 'error' || undefined}
      onKeyDown={handleKeyDown}
    />
  );
}
`,
    css: `/* Generated token references for ${name}. */\n${rules.join("\n\n")}\n`,
  };
}
