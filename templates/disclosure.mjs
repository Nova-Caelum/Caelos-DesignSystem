export const requiredFields = ["kind", "contents", "madeOf", "layerOrder", "variants.variant", "defaultVariants.variant", "states"];

const quote = (value) => JSON.stringify(value);
const union = (values) => values.map(quote).join(" | ");

export function validate({ record }) {
  if (record.layerOrder.length < 2) return { field: "layerOrder", reason: "disclosure needs trigger and panel layers" };
  if (!record.variants.variant.includes(record.defaultVariants.variant)) {
    return { field: "defaultVariants.variant", reason: `defaultVariants.variant names unknown variant ${quote(record.defaultVariants.variant)}` };
  }
  return null;
}

export function render({ className, componentName, name, parts, record }) {
  const control = parts[0];
  if (!control) throw new Error(`Disclosure template for ${name} needs a generated control as its first madeOf part`);
  const variants = record.variants.variant;
  const states = record.states;
  return {
    tsx: `import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEventHandler, type MouseEventHandler, type ReactNode } from 'react';
import { ${control.componentName} as Control } from './${control.componentName}';
import './${componentName}.css';

export type ${componentName}Props = Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'onKeyDown'> & {
  children?: ReactNode;
  contents?: ReactNode;
  triggerLabel?: string;
  open?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  onOpenChange?: (open: boolean) => void;
  state?: ${union(states)};
  variant?: ${union(variants)};
};

const declaredStates = ${JSON.stringify(states)} as readonly string[];
const declaredVariants = ${JSON.stringify(variants)} as readonly string[];

export function ${componentName}({
  children,
  contents,
  defaultOpen = false,
  disabled = false,
  onClick,
  onKeyDown,
  onOpenChange,
  open: controlledOpen,
  state,
  triggerLabel,
  variant = ${quote(record.defaultVariants.variant)},
  ...props
}: ${componentName}Props) {
  const panelId = useId();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const label = triggerLabel ?? ${quote(name)};
  const requestedState = state ?? (declaredStates.includes(variant) ? variant as ${union(states)} : undefined);
  const resolvedVariant = declaredVariants.includes(variant) ? variant : ${quote(record.defaultVariants.variant)};
  const setOpen = (value: boolean) => {
    if (disabled) return;
    if (controlledOpen === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[data-disclosure-trigger]')?.focus());
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div
      {...props}
      ref={rootRef}
      className={[${quote(className)}, props.className].filter(Boolean).join(' ')}
      data-entry=${quote(name)}
      data-state={requestedState ?? (open ? 'open' : 'closed')}
      data-variant={resolvedVariant}
      aria-disabled={disabled || undefined}
    >
      <div data-entry=${quote(name)} data-layer=${quote(record.layerOrder[0])}>
        <Control
          data-live-control
          data-disclosure-trigger
          type="button"
          disabled={disabled}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={(event) => {
            if (disabled) return;
            onClick?.(event);
            if (!event.defaultPrevented) setOpen((value) => !value);
          }}
          onKeyDown={(event) => { if (!disabled) onKeyDown?.(event); }}
        >
          {label}
        </Control>
      </div>
      {open && <div data-entry=${quote(name)} data-layer=${quote(record.layerOrder[1])} id={panelId} data-disclosure-panel>{contents ?? children}</div>}
    </div>
  );
}
`,
    css: `/* ${name} is a tier 3 floating panel; its generated control part owns interaction paint. */\n`,
  };
}
