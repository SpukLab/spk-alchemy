/**
 * CaptureFormatPolicy — governs microphone RECORDING only.
 *
 * Decides which container MediaRecorder should encode to on this device. Has
 * no authority over which existing audio FILES the laboratory can import: that
 * is ImportDecodePolicy, in a separate module. Conflating the two was the
 * exact defect that first suggested this split: it is tempting but wrong to
 * reuse "what this device can record" as "what this device can accept".
 */

/** Preference order for recording. Lossless first, then whatever the device offers. */
export const PREFERRED_MIME_TYPES: readonly string[] = [
  'audio/wav',                  // PCM
  'audio/mp4; codecs=alac',     // ALAC, lossless
  'audio/mp4;codecs=alac',
  'audio/webm; codecs=opus',
  'audio/webm',
  'audio/mp4',                  // AAC fallback
];

export interface RecorderCapability { mimeType: string | null; lossless: boolean }

/** Ask the browser rather than the user agent string. */
export function detectRecorderCapability(
  recorder: { isTypeSupported(t: string): boolean } | undefined =
    (globalThis as unknown as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder,
): RecorderCapability {
  if (!recorder || typeof recorder.isTypeSupported !== 'function') {
    return { mimeType: null, lossless: false };
  }
  for (const type of PREFERRED_MIME_TYPES) {
    if (recorder.isTypeSupported(type)) {
      return { mimeType: type, lossless: /wav|alac/i.test(type) };
    }
  }
  return { mimeType: null, lossless: false }; // browser default
}
