export const requiredFields = ["kind", "contents", "madeOf", "layerOrder", "variants.variant", "defaultVariants.variant", "states"];

const quote = (value) => JSON.stringify(value);
const union = (values) => values.map(quote).join(" | ");

export function validate({ record }) {
  if (record.layerOrder.length < 2) return { field: "layerOrder", reason: "menu needs trigger and menu layers" };
  if (!record.variants.variant.includes(record.defaultVariants.variant)) {
    return { field: "defaultVariants.variant", reason: `defaultVariants.variant names unknown variant ${quote(record.defaultVariants.variant)}` };
  }
  return null;
}

export function render({ className, componentName, name, parts, record }) {
  const control = parts[0];
  if (!control) throw new Error(`Menu template for ${name} needs a generated control as its first madeOf part`);
  const variants = record.variants.variant;
  const states = record.states;
  const defaults = record.contents.map((label, index) => ({ id: `item-${index + 1}`, label: String(label) }));
  return {
    tsx: `import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type KeyboardEventHandler, type MouseEventHandler, type ReactNode } from 'react';
import { ${control.componentName} as Control } from './${control.componentName}';
import './${componentName}.css';

export type ${componentName}Action = { id: string; label: string; type?: 'item'; disabled?: boolean };
export type ${componentName}Checkbox = { id: string; label: string; type: 'checkbox'; checked: boolean; disabled?: boolean };
export type ${componentName}Separator = { id: string; type: 'separator' };
export type ${componentName}Item = ${componentName}Action | ${componentName}Checkbox | ${componentName}Separator;
export type ${componentName}Props = Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'onKeyDown' | 'onSelect'> & {
  children?: ReactNode;
  contents?: readonly ${componentName}Item[];
  triggerLabel?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  onSelect?: (id: string) => void;
  state?: ${union(states)};
  variant?: ${union(variants)};
};

const defaultContents: readonly ${componentName}Item[] = ${JSON.stringify(defaults)};
const declaredStates = ${JSON.stringify(states)} as readonly string[];
const declaredVariants = ${JSON.stringify(variants)} as readonly string[];

export function ${componentName}({
  children,
  contents = defaultContents,
  defaultOpen = false,
  disabled = false,
  onClick,
  onKeyDown,
  onSelect,
  state,
  triggerLabel,
  variant = ${quote(record.defaultVariants.variant)},
  ...props
}: ${componentName}Props) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = triggerLabel ?? (typeof children === 'string' ? children : ${quote(name)});
  const requestedState = state ?? (declaredStates.includes(variant) ? variant as ${union(states)} : undefined);
  const resolvedVariant = declaredVariants.includes(variant) ? variant : ${quote(record.defaultVariants.variant)};
  const enabledItems = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"])') ?? []);

  useEffect(() => {
    if (open) enabledItems()[0]?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus());
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.defaultPrevented) return;
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    const items = enabledItems();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'ArrowDown' ? (current + 1) % items.length
      : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : -1;
    if (index < 0 || items.length === 0) return;
    event.preventDefault();
    items[index]?.focus();
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
          type="button"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="menu"
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
      {open && (
        <div data-entry=${quote(name)} data-layer=${quote(record.layerOrder[1])} role="menu" aria-label={label}>
          {contents.map((item) => item.type === 'separator' ? (
            <div key={item.id} role="separator" />
          ) : (
            <Control
              key={item.id}
              type="button"
              role={item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.type === 'checkbox' ? item.checked : undefined}
              aria-disabled={item.disabled || undefined}
              tabIndex={-1}
              onClick={() => {
                if (item.disabled) return;
                onSelect?.(item.id);
                close();
              }}
            >
              {item.label}
            </Control>
          ))}
        </div>
      )}
    </div>
  );
}
`,
    css: `/* ${name} is a tier 3 shell; its generated control part owns hover and focus paint. */\n`,
  };
}
