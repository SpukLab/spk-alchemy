/**
 * Presentation only. Canonical data MUST remain valid when this registry is
 * empty or absent; nothing here may influence domain validity.
 */
export interface ViewDefinition {
  label: string;
  icon?: string;
  group?: string;
  format?: (record: { id: string; [k: string]: unknown }) => string;
}

export class ViewRegistry {
  readonly #views = new Map<string, ViewDefinition>();
  register(type: string, def: ViewDefinition): void { this.#views.set(type, def); }
  view(type: string): ViewDefinition | null { return this.#views.get(type) ?? null; }
  /** Never throws for unknown types: absence of presentation is not an error. */
  label(type: string): string { return this.#views.get(type)?.label ?? type; }
}
