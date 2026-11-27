import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CatalogFamily, ComponentCatalog } from './catalog';

export function StateCard({ family, state, components }: {
  family: CatalogFamily;
  state: string;
  components: ComponentCatalog;
}) {
  const liveRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState('Measuring');
  const [events, setEvents] = useState({ click: 0, key: 0 });
  const Component = family.componentName ? components[family.componentName] : undefined;
  const disabled = state === 'disabled';

  function handleClick() {
    setEvents((current) => ({ ...current, click: current.click + 1 }));
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      setEvents((current) => ({ ...current, key: current.key + 1 }));
    }
  }

  useEffect(() => {
    const element = liveRef.current?.firstElementChild;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    setSize(`${Math.round(bounds.width)} × ${Math.round(bounds.height)} px`);
  }, [Component, state]);
  return (
    <article
      className="state-card"
      data-state-card={state}
      data-events-click={events.click}
      data-events-key={events.key}
    >
      <header className="card-heading"><h4>{state}</h4><span>{size}</span></header>
      <div className="live-component" ref={liveRef}>
        {Component ? (
          <Component
            variant={state}
            disabled={disabled}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
          >
            {family.title}
          </Component>
        ) : (
          <p className="unavailable">{family.incomplete ? 'incomplete record' : `not generated: ${family.skipReason ?? 'no generated component'}`}</p>
        )}
      </div>
      <small data-event-readout>
        click {events.click} · key {events.key}
      </small>
      {family.lifecycle && <p className="lifecycle" data-lifecycle={family.lifecycle}>Lifecycle: {family.lifecycle}</p>}
      <p className="source-line">Source: <a href={family.sourceHref}>{family.source}</a></p>
      <ul className="token-list">
        {family.tokens.map((token) => (
          <li key={token.path}>
            <a href={token.href} data-token-path={token.path} data-token-value={token.value} data-token-tier={token.tier}>
              <code>{token.path}</code><span>{token.value}</span><span>Tier {token.tier}</span>
            </a>
          </li>
        ))}
      </ul>
    </article>
  );
}
