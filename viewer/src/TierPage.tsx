import type { CatalogTier, ComponentCatalog } from './catalog';
import { FamilyRow } from './FamilyRow';

export function TierPage({ tier, components }: { tier: CatalogTier; components: ComponentCatalog }) {
  return (
    <article className="tier-page" id={tier.id} data-tier-file={tier.file}>
      <header className="tier-heading"><p className="eyebrow">{tier.file}</p><h2>{tier.title}</h2></header>
      {tier.categories.map((category) => (
        <div className="category-section" key={category.name}>
          <h3 className="category-title">{category.name}</h3>
          {category.families.map((family) => <FamilyRow key={family.path} family={family} components={components} />)}
        </div>
      ))}
    </article>
  );
}
