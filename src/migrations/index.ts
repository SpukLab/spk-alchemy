import { SCHEMA_V1 } from '../persistence/schema.ts';
import type { SchemaDeclaration } from '../persistence/schema.ts';
import type { SqliteRecordStore } from '../adapters/node-sqlite/record-store.ts';

/**
 * Forward-only, versioned, deterministic from an empty store.
 * Index declarations are portable and live here; representation is adapter work.
 */
export interface Migration {
  version: number;
  description: string;
  schema: SchemaDeclaration;
  apply: (store: SqliteRecordStore) => Promise<void>;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'canonical collections and initial index declarations',
    schema: SCHEMA_V1,
    apply: async () => { /* declarative: collections and indexes are schema-driven */ },
  },
];

export const CURRENT_SCHEMA = SCHEMA_V1;

export async function migrate(store: SqliteRecordStore): Promise<number> {
  const current = await store.schemaVersion();
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await m.apply(store);
    store.setSchemaVersion(m.version);
  }
  return store.schemaVersion();
}
