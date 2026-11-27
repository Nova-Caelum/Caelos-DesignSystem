export const requiredFields = ["kind", "contents", "madeOf", "layerOrder", "variants.variant", "defaultVariants.variant", "states"];

const quote = (value) => JSON.stringify(value);
const union = (values) => values.map(quote).join(" | ");

export function validate({ record }) {
  if (record.layerOrder.length < 2) {
    return { field: "layerOrder", reason: "tabs need tab-list and panel layers" };
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
  if (!control) throw new Error(`Tabs template for ${name} needs a generated control as its first madeOf part`);
  const variants = record.variants.variant;
  return {
    tsx: `import { useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { ${control.componentName} as Control } from './${control.componentName}';
import './${componentName}.css';

export type ${componentName}Tab = { id: string; label: string; content: ReactNode; disabled?: boolean };
export type ${componentName}Props = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  tabs: readonly ${componentName}Tab[];
  label: string;
  active?: string;
  onChange?: (id: string) => void;
  variant?: ${union(variants)};
};

export function ${componentName}({
  active,
  label,
  onChange,
  onKeyDown,
  tabs,
  variant = ${quote(record.defaultVariants.variant)},
  ...props
}: ${componentName}Props) {
  const baseId = useId();
  const firstEnabled = tabs.find((tab) => !tab.disabled);
  const [localActive, setLocalActive] = useState(firstEnabled?.id ?? '');
  const selectedId = active ?? localActive;
  const selected = tabs.find((tab) => tab.id === selectedId && !tab.disabled) ?? firstEnabled;
  const tabListRef = useRef<HTMLDivElement>(null);
  const select = (id: string) => {
    if (active === undefined) setLocalActive(id);
    onChange?.(id);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || (event.target as HTMLElement).getAttribute('role') !== 'tab') return;
    if (event.key === 'Escape') {
      (event.target as HTMLElement).blur();
      return;
    }
    const enabledTabs = tabs.filter((tab) => !tab.disabled);
    const focusedId = (event.target as HTMLElement).dataset.tabId;
    const index = Math.max(0, enabledTabs.findIndex((tab) => tab.id === focusedId));
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % enabledTabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + enabledTabs.length) % enabledTabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? enabledTabs.length - 1
            : undefined;
    if (nextIndex === undefined || enabledTabs.length === 0) return;
    const next = enabledTabs[nextIndex];
    event.preventDefault();
    select(next.id);
    tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')[nextIndex]?.focus();
  };

  return (
    <div
      {...props}
      className={[${quote(className)}, props.className].filter(Boolean).join(' ')}
      data-entry=${quote(name)}
      data-state={selected ? 'active' : 'inactive'}
      data-variant={variant}
    >
      <div ref={tabListRef} data-layer=${quote(record.layerOrder[0])} role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
        {tabs.map((tab) => {
          const isSelected = tab.id === selected?.id;
          return (
            <Control
              key={tab.id}
              id={\`\${baseId}-tab-\${tab.id}\`}
              data-tab-id={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={\`\${baseId}-panel\`}
              disabled={tab.disabled}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => select(tab.id)}
            >
              {tab.label}
            </Control>
          );
        })}
      </div>
      {selected && (
        <div
          id={\`\${baseId}-panel\`}
          data-layer=${quote(record.layerOrder[1])}
          role="tabpanel"
          aria-labelledby={\`\${baseId}-tab-\${selected.id}\`}
          tabIndex={0}
        >
          {selected.content}
        </div>
      )}
    </div>
  );
}
`,
    css: `/* ${name} composes generated controls; those controls own hover and focus paint. */\n`,
  };
}
