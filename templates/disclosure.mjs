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
    tsx: `import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ${control.componentName} as Control } from './${control.componentName}';
import './${componentName}.css';

export type ${componentName}Props = HTMLAttributes<HTMLDivElement> & {
  children?: ReactNode;
  contents?: ReactNode;
  triggerLabel?: string;
  open?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
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
  const wasOpen = useRef(open);
  const label = triggerLabel ?? ${quote(name)};
  const requestedState = state ?? (declaredStates.includes(variant) ? variant as ${union(states)} : undefined);
  const resolvedVariant = declaredVariants.includes(variant) ? variant : ${quote(record.defaultVariants.variant)};
  const setOpen = (value: boolean) => {
    if (disabled) return;
    if (controlledOpen === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (!open && wasOpen.current) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[data-disclosure-trigger]')?.focus());
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [open]);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    onClick?.(event);
    if (!event.defaultPrevented && event.target === event.currentTarget) setOpen((value) => !value);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      setOpen((value) => !value);
      return;
    }
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      {...props}
      ref={rootRef}
      className={[${quote(className)}, props.className].filter(Boolean).join(' ')}
      data-entry=${quote(name)}
      data-state={requestedState ?? (open ? 'open' : 'closed')}
      data-variant={resolvedVariant}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? undefined : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div data-entry=${quote(name)} data-layer=${quote(record.layerOrder[0])}>
        <Control data-disclosure-trigger type="button" disabled={disabled} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
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
