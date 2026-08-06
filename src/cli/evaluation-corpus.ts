import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lab } from './context.ts';
import { DEFAULT_FRAGMENT_EXPLORATION } from '../domain/alchemy/research-configuration.ts';
import { exportPreviewSet } from './exploration-cli.ts';
import { synthesize, encodeWav } from '../audio/wav.ts';
import { selectVariation } from '../domain/alchemy/exploration.ts';

/**
 * Produces a listening corpus so the artist can evaluate the loop.
 *
 * It reports counts, seeds, timings and genealogy depth. It makes NO claim
 * about artistic quality: that judgement is the artist's, and the numbers here
 * exist only so the listening is informed.
 */
export interface EvaluationReport {
  sourceCount: number;
  previewCount: number;
  retainedCount: number;
  promotedCount: number;
  rejectedCount: number;
  uniqueOutputHashes: number;
  variationSeeds: number[];
  secondGenerationPreviews: number;
  genealogyDepth: number;
  durationMs: number;
  outputDirectory: string;
}

export async function buildEvaluationCorpus(
  lab: Lab, outputDir: string, variationsPerSource = 8,
): Promise<EvaluationReport> {
  const started = Date.now();
  await mkdir(outputDir, { recursive: true });

  const artist = await lab.service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const intent = await lab.service.createResearchIntent({
    question: 'discover material that keeps its identity across fragmentation',
    successCriteria: 'variations remain recognisably related to their source',
    agentId: artist.id,
  });

  // Three representative sources with deliberately different character.
  const sources = [];
  for (const [i, seed] of [3, 17, 41].entries()) {
    const bytes = encodeWav(synthesize(seed, 8000, 1, 5000));
    sources.push(await lab.service.importMaterial({
      bytes, filename: `source-${i + 1}-seed${seed}.wav`, agentId: artist.id }));
    await writeFile(join(outputDir, `source-${i + 1}-seed${seed}.wav`), bytes);
  }

  const allHashes = new Set<string>();
  const seeds: number[] = [];
  let previewCount = 0;
  const retained: string[] = [];

  for (const [i, source] of sources.entries()) {
    const set = await lab.service.runResearchConfiguration({
      materialId: source.id, configuration: DEFAULT_FRAGMENT_EXPLORATION,
      researchIntentId: intent.id, baseSeed: 1000 * (i + 1),
      variationCount: variationsPerSource, agentId: artist.id });
    await exportPreviewSet(set, join(outputDir, `source-${i + 1}`));
    previewCount += set.variations.length;
    for (const v of set.variations) { allHashes.add(v.preview.contentHash); seeds.push(v.seed); }

    // Retain two per source; promote one, reject the other.
    const keep = await lab.service.retain(selectVariation(set, 0).preview, artist.id, 'keeper');
    const drop = await lab.service.retain(selectVariation(set, 1).preview, artist.id, 'for the record');
    await lab.service.promote(keep.material.id, artist.id);
    await lab.service.reject(drop.material.id, artist.id, 'loses the source identity');
    retained.push(keep.material.id, drop.material.id);
  }

  // One second-generation exploration over the first promoted result.
  const gen2 = await lab.service.runResearchConfiguration({
    materialId: retained[0]!, configuration: DEFAULT_FRAGMENT_EXPLORATION,
    researchIntentId: intent.id, baseSeed: 9000, variationCount: 4, agentId: artist.id });
  await exportPreviewSet(gen2, join(outputDir, 'generation-2'));
  for (const v of gen2.variations) { allHashes.add(v.preview.contentHash); seeds.push(v.seed); }
  const gen2Retained = await lab.service.retain(selectVariation(gen2, 0).preview, artist.id);
  await lab.service.promote(gen2Retained.material.id, artist.id);

  const ancestors = await lab.queries.ancestors(gen2Retained.material.id);
  const genealogyDepth = ancestors.nodes.reduce((m, n) => Math.max(m, n.depth), 0);

  const promoted = await lab.queries.promotedMaterials(undefined, 200);
  const rejected = await lab.queries.materialsByLifecycle('rejected', undefined, 200);
  const retainedOnly = await lab.queries.materialsByLifecycle('retained', undefined, 200);

  const report: EvaluationReport = {
    sourceCount: sources.length,
    previewCount: previewCount + gen2.variations.length,
    retainedCount: retainedOnly.items.length,
    promotedCount: promoted.items.length,
    rejectedCount: rejected.items.length,
    uniqueOutputHashes: allHashes.size,
    variationSeeds: seeds,
    secondGenerationPreviews: gen2.variations.length,
    genealogyDepth,
    durationMs: Date.now() - started,
    outputDirectory: outputDir,
  };
  await writeFile(join(outputDir, 'evaluation-report.json'), JSON.stringify(report, null, 2));
  return report;
}
