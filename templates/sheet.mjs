export const requiredFields = ["kind", "contents", "madeOf", "layerOrder", "variants.variant", "defaultVariants.variant", "states"];

const quote = (value) => JSON.stringify(value);
const union = (values) => values.map(quote).join(" | ");

export function validate({ record }) {
  if (record.layerOrder.length < 2) return { field: "layerOrder", reason: "sheet needs trigger and dialog layers" };
  if (!record.variants.variant.includes(record.defaultVariants.variant)) {
    return { field: "defaultVariants.variant", reason: `defaultVariants.variant names unknown variant ${quote(record.defaultVariants.variant)}` };
  }
  return null;
}

export function render({ className, componentName, name, parts, record }) {
  const control = parts[0];
  if (!control) throw new Error(`Sheet template for ${name} needs a generated control as its first madeOf part`);
  const variants = record.variants.variant;
  const states = record.states;
  return {
    tsx: `import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type KeyboardEventHandler, type MouseEventHandler, type ReactNode } from 'react';
import { ${control.componentName} as Control } from './${control.componentName}';
import './${componentName}.css';

export type ${componentName}Props = Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'onKeyDown' | 'title'> & {
  children?: ReactNode;
  contents?: ReactNode;
  title?: string;
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
const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

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
  title,
  triggerLabel,
  variant = ${quote(record.defaultVariants.variant)},
  ...props
}: ${componentName}Props) {
  const titleId = useId();
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);
  const heading = title ?? ${quote(name)};
  const label = triggerLabel ?? (typeof children === 'string' ? children : ${quote(name)});
  const requestedState = state ?? (declaredStates.includes(variant) ? variant as ${union(states)} : undefined);
  const resolvedVariant = declaredVariants.includes(variant) ? variant : ${quote(record.defaultVariants.variant)};
  const setOpen = (value: boolean) => {
    if (disabled) return;
    if (controlledOpen === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLButtonElement>('[data-sheet-close]')?.focus();
    if (!open && wasOpen.current) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[data-sheet-trigger]')?.focus());
    wasOpen.current = open;
  }, [open]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.defaultPrevented) return;
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = rootRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
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
      onKeyDown={handleKeyDown}
    >
      <div data-entry=${quote(name)} data-layer=${quote(record.layerOrder[0])}>
        <Control
          data-live-control
          data-sheet-trigger
          type="button"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={(event) => {
            if (disabled) return;
            onClick?.(event);
            if (!event.defaultPrevented) setOpen(true);
          }}
          onKeyDown={(event) => { if (!disabled) onKeyDown?.(event); }}
        >
          {label}
        </Control>
      </div>
      {open && (
        <div
          data-sheet-backdrop
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div data-entry=${quote(name)} data-layer=${quote(record.layerOrder[1])} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
            <h2 data-entry=${quote(name)} id={titleId}>{heading}</h2>
            <Control data-sheet-close type="button" aria-label={\`Close \${heading}\`} onClick={() => setOpen(false)}>Close</Control>
            {contents ?? children}
          </div>
        </div>
      )}
    </div>
  );
}
`,
    css: `.${className} > [data-sheet-backdrop] {\n  position: fixed;\n  inset: 0;\n}\n\n/* ${name} is a tier 3 shell; its generated control part owns hover and focus paint. */\n`,
  };
}
