// Caelos product colours: the bottom tier, and the only place in this repository a raw colour may live.
// One entry per colour of the brand library's product-palette.json, keyed by its role, in the record's
// order. The palette job fails if this file and that record differ in any role or value.
// Format, parsed strictly: one `  'role': '#RRGGBB',` line per colour inside the block below.

export const color = {
  'chrome': '#080817',
  'ground': '#100F1C',
  'elevated': '#161627',
  'elevated-2': '#1E1E30',
  'top': '#262639',
  'text-primary': '#EDE3CF',
  'text-supporting': '#9B958B',
  'text-tertiary': '#717184',
  'text-faint': '#53546E',
  'action-blue': '#678BEC',
  'action-blue-hover': '#779CFF',
  'success': '#8BB5A8',
  'golden-sand': '#C4AC7C',
  'peach-gold': '#E8B67A',
  'danger': '#C25B62',
  'danger-hover': '#C98589',
  'ready': '#8E96CC',
  'light-ground': '#F2E8D9',
  'structural-violet': '#3F3D6C',
  'rose-hover': '#C98589',
} as const;

export type ColorRole = keyof typeof color;
