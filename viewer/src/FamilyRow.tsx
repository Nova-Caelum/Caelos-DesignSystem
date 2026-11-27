import type { CatalogFamily, ComponentCatalog } from './catalog';
import { StateCard } from './StateCard';

export function FamilyRow({ family, components }: { family: CatalogFamily; components: ComponentCatalog }) {
  return (
    <section className="family-row" data-family={family.path}>
      <div className="family-identity">
        <p className="eyebrow">Identity</p>
        <h3>{family.title}</h3>
        <code>{family.path}</code>
        <p data-lifecycle={family.lifecycle}>Lifecycle: {family.lifecycle}</p>
        {family.incomplete && <p className="unavailable">incomplete record</p>}
        <details className="recipe-preview">
          <summary>Recipe preview</summary>
          <pre>{family.recipe}</pre>
        </details>
      </div>
      <div className="state-cards">
        {family.states.map((state) => <StateCard key={state} family={family} state={state} components={components} />)}
      </div>
    </section>
  );
}
