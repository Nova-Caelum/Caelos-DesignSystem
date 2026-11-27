import type { ComponentCatalog, ViewerCatalog } from './catalog';
import { FirstScreen } from './FirstScreen';
import { TierPage } from './TierPage';

export function App({ catalog, components }: { catalog: ViewerCatalog; components: ComponentCatalog }) {
  return (
    <main className="viewer-shell">
      <FirstScreen catalog={catalog} />
      <nav className="table-of-contents" aria-label="Tier table of contents">
        <p className="eyebrow">Table of contents</p>
        <ol>{catalog.tiers.map((tier) => <li key={tier.file}><a href={`#${tier.id}`}>{tier.file} · {tier.title}</a></li>)}</ol>
      </nav>
      {catalog.tiers.map((tier) => <TierPage key={tier.file} tier={tier} components={components} />)}
    </main>
  );
}
