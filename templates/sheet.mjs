export const requiredFields = ["kind", "contents", "madeOf", "layerOrder", "variants.variant", "defaultVariants.variant", "states"];

const quote = (value) => JSON.stringify(value);
const union = (values) => values.map(quote).join(" | ");

export function validate({ record }) {
  if (record.layerOrder.length < 2) {
    return { field: "layerOrder", reason: "sheet needs trigger and dialog layers" };
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
  if (!control) throw new Error(`Sheet template for ${name} needs a generated control as its first madeOf part`);
  const variants = record.variants.variant;
  return {
    tsx: `import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { ${control.componentName} as Control } from './${control.componentName}';
import './${componentName}.css';

export type ${componentName}Props = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  children?: ReactNode;
  contents?: ReactNode;
  title: string;
  triggerLabel: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: ${union(variants)};
};

export function ${componentName}({
  children,
  contents,
  defaultOpen = false,
  onKeyDown,
  onOpenChange,
  open: controlledOpen,
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
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  };
  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLButtonElement>('[data-sheet-close]')?.focus();
    if (!open && wasOpen.current) {
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[data-sheet-trigger]')?.focus());
    }
    wasOpen.current = open;
  }, [open]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
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
        <Control data-sheet-trigger type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          {triggerLabel}
        </Control>
      </div>
      {open && (
        <div
          data-layer=${quote(record.layerOrder[1])}
          role="dialog"
          aria-labelledby={titleId}
        >
          <h2 id={titleId}>{title}</h2>
          <Control data-sheet-close type="button" aria-label={\`Close \${title}\`} onClick={() => setOpen(false)}>
            Close
          </Control>
          {contents ?? children}
        </div>
      )}
    </div>
  );
}
`,
    css: `/* ${name} is a tier 3 shell; its generated control part owns hover and focus paint. */\n`,
  };
}
