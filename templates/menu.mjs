export const requiredFields = ["kind", "contents", "madeOf", "layerOrder", "variants.variant", "defaultVariants.variant", "states"];

const quote = (value) => JSON.stringify(value);
const union = (values) => values.map(quote).join(" | ");

export function validate({ record }) {
  if (record.layerOrder.length < 2) {
    return { field: "layerOrder", reason: "menu needs trigger and menu layers" };
  }
  if (!record.variants.variant.includes(record.defaultVariants.variant)) {
    return {
      field: "defaultVariants.variant",
      reason: `defaultVariants.variant names unknown variant ${quote(record.defaultVariants.variant)}`,
    };
  }
  return null;
}

export function render({ className, componentName, name, parts, record }) {
  const control = parts[0];
  if (!control) throw new Error(`Menu template for ${name} needs a generated control as its first madeOf part`);
  const variants = record.variants.variant;
  return {
    tsx: `import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent } from 'react';
import { ${control.componentName} as Control } from './${control.componentName}';
import './${componentName}.css';

export type ${componentName}Item = { id: string; label: string; disabled?: boolean };
export type ${componentName}Props = Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> & {
  contents: readonly ${componentName}Item[];
  triggerLabel: string;
  onSelect?: (id: string) => void;
  variant?: ${union(variants)};
};

export function ${componentName}({
  contents,
  onKeyDown,
  onSelect,
  triggerLabel,
  variant = ${quote(record.defaultVariants.variant)},
  ...props
}: ${componentName}Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const enabledItems = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useEffect(() => {
    if (open) enabledItems()[0]?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus());
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !open) return;
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
      data-state={open ? 'open' : 'closed'}
      data-variant={variant}
      onKeyDown={handleKeyDown}
    >
      <div data-layer=${quote(record.layerOrder[0])}>
        <Control type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
          {triggerLabel}
        </Control>
      </div>
      {open && (
        <div data-layer=${quote(record.layerOrder[1])} role="menu" aria-label={triggerLabel}>
          {contents.map((item) => (
            <Control
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
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
