/**
 * DnaPackExportController — mutually exclusive Download/Share orchestration.
 *
 * The physical-device defect: one Publish press called both the anchor
 * download AND navigator.share() unconditionally, so Safari showed its
 * download confirmation behind the native share/save sheet, and accepting it
 * downloaded the same ZIP a second time.
 *
 * This controller enforces the invariant directly: publishAndDownload() is the
 * ONLY caller of the canonical publish action and the ONLY caller of download;
 * shareLast() reuses the already-published bytes and NEVER calls publish or
 * download again, regardless of share outcome (success, user cancellation, or
 * failure). Two independent single-flight guards prevent a duplicate tap on
 * either button from doing either action twice. This is UI/runtime protection
 * only — it adds no canonical state; the guarded call still creates exactly
 * one Published Artifact per successful invocation, same as before.
 */

export interface DnaPackArtifact {
  filename: string;
  zip: Uint8Array;
  manifest: unknown;
}

export interface ExportDeps {
  /** Must invoke exactly one native download interaction (e.g. one anchor .click()). */
  download: (filename: string, bytes: Uint8Array, mime: string) => void;
  /** Must invoke navigator.share (or equivalent) exactly once and resolve the outcome. */
  share: (filename: string, bytes: Uint8Array, mime: string) => Promise<'shared' | 'cancelled'>;
  /** Pure capability check — never itself downloads or shares. */
  canShareFiles: (filename: string, bytes: Uint8Array, mime: string) => boolean;
}

export type PublishFn = () => Promise<DnaPackArtifact>;

export class DnaPackExportController {
  #deps: ExportDeps;
  #publishing = false;
  #sharing = false;
  #lastArtifact: { familyId: string; filename: string; zip: Uint8Array } | null = null;

  constructor(deps: ExportDeps) { this.#deps = deps; }

  isPublishing(): boolean { return this.#publishing; }
  isSharing(): boolean { return this.#sharing; }

  /** True only when there is a just-published artifact for this exact Family, sharable now. */
  canShareLast(familyId: string): boolean {
    if (!this.#lastArtifact || this.#lastArtifact.familyId !== familyId) return false;
    return this.#deps.canShareFiles(this.#lastArtifact.filename, this.#lastArtifact.zip, 'application/zip');
  }

  /**
   * One gesture, one export path: calls `publish` at most once (never while
   * already publishing), then downloads the result exactly once. Never calls
   * share. Returns null if a publish was already in flight — the duplicate
   * tap is ignored, not queued, not retried.
   */
  async publishAndDownload(familyId: string, publish: PublishFn): Promise<DnaPackArtifact | null> {
    if (this.#publishing) return null;
    this.#publishing = true;
    try {
      const artifact = await publish();
      this.#lastArtifact = { familyId, filename: artifact.filename, zip: artifact.zip };
      this.#deps.download(artifact.filename, artifact.zip, 'application/zip');
      return artifact;
    } finally {
      this.#publishing = false;
    }
  }

  /**
   * Reuses the artifact from the most recent publish for this Family. Never
   * re-publishes (no new Published Artifact, no version bump) and never
   * downloads — success, cancellation and failure all leave the download path
   * completely untouched.
   */
  async shareLast(familyId: string): Promise<'shared' | 'cancelled' | 'unavailable'> {
    if (this.#sharing) return 'unavailable';
    if (!this.#lastArtifact || this.#lastArtifact.familyId !== familyId) return 'unavailable';
    this.#sharing = true;
    try {
      return await this.#deps.share(this.#lastArtifact.filename, this.#lastArtifact.zip, 'application/zip');
    } finally {
      this.#sharing = false;
    }
  }

  /** Clears the shareable artifact — call when leaving the Family screen. */
  reset(): void { this.#lastArtifact = null; }
}
