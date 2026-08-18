/**
 * Spanish display labels for Mesa strategies and territories.
 *
 * Presentation only — strategy identifiers in mesa.ts remain the source of
 * truth, and this module maps them for display. Deliberately a domain module
 * rather than inline UI strings so both the browser and any future surface
 * read the same mapping, and so a renamed strategy id fails loudly here
 * instead of silently rendering a blank label.
 */
import { MEDIUM_STRATEGIES, UNEXPECTED_STRATEGIES } from './mesa.ts';
import type { Territory } from './mesa.ts';

export const TERRITORY_LABELS: Readonly<Record<Territory, string>> = {
  medium: 'Observaciones medias',
  unexpected: 'Observaciones inesperadas',
};

const STRATEGY_LABELS: Readonly<Record<string, string>> = {
  'medium-structure': 'Estructura',
  'medium-fragment': 'Fragmentación',
  'medium-temporal': 'Temporal',
  'medium-texture': 'Textura',
  'unexpected-temporal-deviation': 'Temporal',
  'unexpected-microscopic-deviation': 'Microscópica',
  'unexpected-energetic-deviation': 'Energética',
  'unexpected-hybrid-deviation': 'Híbrida',
};

export function strategyLabel(strategyId: string): string {
  return STRATEGY_LABELS[strategyId] ?? strategyId;
}

export function territoryLabel(territory: Territory): string {
  return TERRITORY_LABELS[territory] ?? territory;
}

/** Every registered strategy must have a label; guards against silent gaps. */
export function missingStrategyLabels(): string[] {
  return [...MEDIUM_STRATEGIES, ...UNEXPECTED_STRATEGIES]
    .map((s) => s.id)
    .filter((id) => !(id in STRATEGY_LABELS));
}
