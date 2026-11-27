import type { ViewerCatalog } from './catalog';

export function FirstScreen({ catalog }: { catalog: ViewerCatalog }) {
  const oldest = catalog.oldestDraftDays === null ? 'None' : `${catalog.oldestDraftDays} days`;
  return (
    <header className="first-screen">
      <p className="eyebrow">Caelos design system</p>
      <h1>Catalog viewer</h1>
      <p className="intro">Tier recipes, lifecycle evidence, generated controls, and unresolved generator gaps.</p>
      <div className="summary-grid" aria-label="Catalog health">
        <article className="summary-card" data-draft-count={catalog.draftCount}>
          <strong>{catalog.draftCount}</strong><span>Draft records</span>
        </article>
        <article className="summary-card" data-oldest-draft-days={catalog.oldestDraftDays ?? ''}>
          <strong>{oldest}</strong><span>Oldest draft</span>
        </article>
        <article className="summary-card" data-gap-count={catalog.gaps.length}>
          <strong>{catalog.gaps.length}</strong><span>Awaiting a value</span>
        </article>
      </div>
      {catalog.gaps.length > 0 && (
        <details className="gap-list">
          <summary>Generator gaps</summary>
          <ul>{catalog.gaps.map((gap) => <li key={`${gap.entry}:${gap.reason}`}><code>{gap.entry}</code>: {gap.reason}</li>)}</ul>
        </details>
      )}
    </header>
  );
}
