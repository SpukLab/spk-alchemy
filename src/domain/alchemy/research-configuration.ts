import type { AudioBuffer } from '../../audio/wav.ts';
import { decodeWav, encodeWav } from '../../audio/wav.ts';
import {
  seededRandom, fragmentEvenly, shuffleWithSeed, sliceFragment,
  reverseFrames, applyGain, silence, concatSamples,
} from '../../audio/operations.ts';

/**
 * ResearchConfiguration — a versioned domain configuration contract.
 *
 * It is NOT a canonical structural primitive and NOT a persistent Entity in
 * this phase. It is executable, versioned configuration; what persists on
 * Retain is its id, version, operation sequence, parameters and seed, recorded
 * in the resulting Material's provenance.
 *
 * One built-in configuration only. No node editor, no user-authored methods,
 * no plugin system, no DSP language.
 */

export const RESEARCH_CONFIGURATION_SCHEMA_VERSION = 1;

export interface OperationStep {
  operation: string;
  description: string;
}

export interface ParameterRange {
  min: number;
  max: number;
  description: string;
}

export interface InputConstraints {
  requiredEncoding: 'pcm16-wav';
  minFrames: number;
  maxChannels: number;
}

export interface ResearchConfiguration {
  id: string;
  name: string;
  version: string;
  schemaVersion: number;
  implementationVersion: string;
  inputConstraints: InputConstraints;
  operations: readonly OperationStep[];
  parameterRanges: Readonly<Record<string, ParameterRange>>;
  defaultVariationCount: number;
  seedStrategy: 'base-plus-index';
  /** Derives each variation's seed from the base seed. Fully determined. */
  variationSeed: (baseSeed: number, index: number) => number;
  /** Deterministic transform: identical arguments always yield identical bytes. */
  render: (inputBytes: Uint8Array, seed: number) => Uint8Array;
}

/** Parameters chosen for one variation, recorded in provenance. */
export interface DerivedParameters {
  fragmentCount: number;
  reversedFragments: number[];
  silenceFrames: number;
  gainNumerator: number;
  gainDenominator: number;
  order: number[];
}

function deriveParameters(seed: number, totalFrames: number): DerivedParameters {
  const rng = seededRandom(seed);
  const fragmentCount = 3 + Math.floor(rng() * 6);          // 3..8
  const fragments = fragmentEvenly(totalFrames, fragmentCount);
  const indices = fragments.map((_, i) => i);
  const order = shuffleWithSeed(indices, rng);
  const reversedFragments = order.filter(() => rng() < 0.4);
  const silenceFrames = Math.floor(rng() * 800);            // 0..799
  const gainNumerator = 6 + Math.floor(rng() * 5);          // 6..10
  return {
    fragmentCount: fragments.length, reversedFragments,
    silenceFrames, gainNumerator, gainDenominator: 10, order,
  };
}

function renderVariation(audio: AudioBuffer, seed: number): AudioBuffer {
  const frames = audio.samples.length / audio.channels;
  const params = deriveParameters(seed, frames);
  const fragments = fragmentEvenly(frames, params.fragmentCount);
  const reversed = new Set(params.reversedFragments);
  const gap = silence(params.silenceFrames, audio.channels);

  const parts: Int16Array[] = [];
  params.order.forEach((fragmentIndex, position) => {
    const fragment = fragments[fragmentIndex];
    if (!fragment) return;
    let piece = sliceFragment(audio, fragment);
    if (reversed.has(fragmentIndex)) piece = reverseFrames(piece, audio.channels);
    // Gain shaping decays across positions, so ordering is audible.
    const numerator = Math.max(3, params.gainNumerator - position);
    piece = applyGain(piece, numerator, params.gainDenominator);
    parts.push(piece);
    if (position < params.order.length - 1 && gap.length > 0) parts.push(gap);
  });

  return { ...audio, samples: concatSamples(parts) };
}

export const FRAGMENT_EXPLORATION_V1: ResearchConfiguration = {
  id: 'fragment-exploration-v1',
  name: 'Fragment exploration',
  version: '1.0.0',
  schemaVersion: RESEARCH_CONFIGURATION_SCHEMA_VERSION,
  implementationVersion: '1.0.0',
  inputConstraints: { requiredEncoding: 'pcm16-wav', minFrames: 64, maxChannels: 2 },
  operations: [
    { operation: 'fragment', description: 'divide the input into deterministic fragments' },
    { operation: 'reorder', description: 'permute fragments using the variation seed' },
    { operation: 'reverse', description: 'reverse a seed-selected subset of fragments' },
    { operation: 'space', description: 'insert controlled silence between fragments' },
    { operation: 'gain', description: 'integer gain shaping decaying across positions' },
    { operation: 'reconstruct', description: 'rebuild a canonical PCM16 WAV result' },
  ],
  parameterRanges: {
    fragmentCount: { min: 3, max: 8, description: 'number of deterministic fragments' },
    silenceFrames: { min: 0, max: 799, description: 'frames of silence between fragments' },
    gainNumerator: { min: 3, max: 10, description: 'integer gain numerator over denominator 10' },
  },
  defaultVariationCount: 8,
  seedStrategy: 'base-plus-index',
  variationSeed: (baseSeed, index) => (baseSeed + index * 7919) >>> 0,
  render: (inputBytes, seed) => encodeWav(renderVariation(decodeWav(inputBytes), seed)),
};

export const BUILT_IN_CONFIGURATIONS: readonly ResearchConfiguration[] = [FRAGMENT_EXPLORATION_V1];

export function configurationById(id: string): ResearchConfiguration {
  const found = BUILT_IN_CONFIGURATIONS.find((c) => c.id === id);
  if (!found) throw new Error(`unknown research configuration: ${id}`);
  return found;
}

export function describeParameters(seed: number, totalFrames: number): DerivedParameters {
  return deriveParameters(seed, totalFrames);
}
