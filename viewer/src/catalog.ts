import type { ComponentType } from 'react';

export type CatalogToken = { path: string; value: string; tier: number; source: string; href: string };
export type CatalogFamily = {
  path: string;
  title: string;
  lifecycle: string;
  states: string[];
  tokens: CatalogToken[];
  source: string;
  sourceHref: string;
  recipe: string;
  componentName?: string;
  skipReason?: string;
  incomplete: boolean;
};
export type CatalogCategory = { name: string; families: CatalogFamily[] };
export type CatalogTier = { file: string; id: string; title: string; categories: CatalogCategory[] };
export type ViewerCatalog = {
  tiers: CatalogTier[];
  draftCount: number;
  oldestDraftDays: number | null;
  gaps: Array<{ entry: string; reason: string }>;
};
export type ComponentCatalog = Record<string, ComponentType<Record<string, unknown>>>;
