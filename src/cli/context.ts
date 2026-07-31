import { SqliteRecordStore } from '../adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../adapters/content-fs/content-store.ts';
import { DataRegistry } from '../registries/data-registry.ts';
import { ViewRegistry } from '../registries/view-registry.ts';
import { registerAlchemyVocabulary } from '../domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../domain/alchemy/service.ts';
import { AlchemyQueries } from '../query/queries.ts';
import { migrate, CURRENT_SCHEMA } from '../migrations/index.ts';

export interface Lab {
  records: SqliteRecordStore;
  content: FsContentStore;
  data: DataRegistry;
  view: ViewRegistry;
  service: AlchemyService;
  queries: AlchemyQueries;
  close: () => Promise<void>;
}

/** Composition root. This is the only place that knows about Node adapters. */
export async function openLab(root = '.data'): Promise<Lab> {
  const records = new SqliteRecordStore(`${root}/alchemy.sqlite`, CURRENT_SCHEMA);
  const content = new FsContentStore(`${root}/content`);
  await migrate(records);
  const data = new DataRegistry();
  const view = new ViewRegistry();
  registerAlchemyVocabulary(data, view);
  const service = new AlchemyService(records, content, data);
  const queries = new AlchemyQueries(records, content);
  return {
    records, content, data, view, service, queries,
    close: async () => { await records.close(); await content.close(); },
  };
}
