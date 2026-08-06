import { normalizeToCanonicalWav } from './normalize.ts';
import type { NormalizeOptions } from './normalize.ts';

/**
 * ImportDecodePolicy — governs importing EXISTING audio files.
 *
 * Deliberately separate from CaptureFormatPolicy. What this device can record
 * with MediaRecorder says nothing about what files it can decode: Safari
 * accepts WAV and AIFF for decodeAudioData on every version that matters here,
 * even on devices that cannot record WAV with MediaRecorder. Filtering imports
 * by the recording codec list was the defect; this module exists so it cannot
 * happen again by accident.
 *
 * Extension and MIME type are HINTS ONLY, used for the file-picker `accept`
 * attribute and for a friendlier error message. Neither is ever used to reject
 * a file outright — the only authoritative check is an actual decode attempt
 * through the shared boundary in normalize.ts.
 */

/**
 * Broad on purpose. iOS Safari's Files picker filters selectable files by a
 * UTI it derives from this attribute, and many WAV/AIFF files exported by
 * third-party apps (including SpukLab's own Sound Forge) are not tagged with
 * a UTI Safari recognises as strictly "audio/*". Listing explicit extensions
 * alongside the generic types is what makes those files selectable at all;
 * `audio/*` alone is not sufficient on iOS.
 */
export const IMPORT_ACCEPT_HINT =
  '.wav,.wave,.aif,.aiff,.m4a,.mp4,.caf,audio/*,video/mp4';

const KNOWN_EXTENSIONS = new Set([
  'wav', 'wave', 'aif', 'aiff', 'm4a', 'mp4', 'caf',
]);

export interface ImportHint {
  extension: string | null;
  reportedMimeType: string;
  /** Whether the extension or MIME look like audio. Informational only. */
  recognized: boolean;
}

/** Describes a file for UI purposes. Never used to accept or reject it. */
export function describeImportCandidate(file: { name: string; type: string }): ImportHint {
  const match = /\.([a-z0-9]+)$/i.exec(file.name);
  const extension = match ? match[1]!.toLowerCase() : null;
  const mimeLooksLikeAudio = file.type === '' || /^audio\//i.test(file.type)
    || /^video\/mp4$/i.test(file.type); // m4a sometimes reports as video/mp4 on iOS
  return {
    extension,
    reportedMimeType: file.type,
    recognized: mimeLooksLikeAudio || (extension !== null && KNOWN_EXTENSIONS.has(extension)),
  };
}

export class ImportDecodeError extends Error {
  readonly filename: string;
  readonly cause2: unknown;
  constructor(filename: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`No se pudo leer "${filename}" como audio (${reason}).`);
    this.name = 'ImportDecodeError';
    this.filename = filename;
    this.cause2 = cause;
  }
}

type DecoderContext = Parameters<typeof normalizeToCanonicalWav>[1];

/**
 * The one authoritative check: attempt an actual decode. file.type and the
 * extension are never consulted here — only the bytes matter. On failure,
 * nothing is created upstream, because the caller only proceeds with bytes
 * this function returns.
 */
export async function decodeImportedFile(
  filename: string,
  bytes: ArrayBuffer,
  createContext: DecoderContext,
  options?: NormalizeOptions,
): Promise<Uint8Array> {
  try {
    return await normalizeToCanonicalWav(bytes, createContext, options);
  } catch (cause) {
    throw new ImportDecodeError(filename, cause);
  }
}
