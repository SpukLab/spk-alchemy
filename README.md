# Spk_Alchemy — SpukLab Knowledge Graph foundation

Spk_Alchemy is a creative research laboratory. It exists to discover reusable
sound DNA that later feeds Sound Forge, FieldsSet, SBO, external DAWs and
future visual systems such as Phonema. It is not a DAW, a sampler, a sequencer
or a performance environment.

Alchemy transforms material **in order to learn**. Sound Forge transforms
material **in order to finish**. The operation alone does not decide the
domain — Research Intent and success criteria do.

## Scope of this repository

This is the **first vertical slice**: architectural validation, not a product.
It proves the substrate survives contact with real materials, real persistence
and real queries.

Implemented cycle:

```
import material → persistent Entity → deterministic content hash
  → versioned Observations attributed to Agents
  → Research Intent → deterministic Experiment
  → runtime Preview → Discard | Retain
  → Retain creates the persistent Material Entity with full genealogy
  → Promote | Reject as lifecycle Transitions over that same Entity
  → query purpose, provenance, analysis, transformation and genealogy
```

Not implemented, deliberately: Alchemy UI, Bench interaction, browser adapter,
perceptual AI, Family authoring, DNA Pack publication, FieldsSet integration,
automatic deduplication, analysis caching.

## Material Exploration Loop

The artistic loop on top of the substrate:

```bash
npm run seed                      # a corpus to explore
npm run explore -- --variations 8 --seed 1000 --output ./previews
# listen to ./previews/*.wav, then:
npm run compare -- --output ./previews
npm run retain -- --preview <id> --output ./previews
npm run promote -- --material <id>
npm run reject  -- --material <id>
npm run corpus                    # full listening corpus for evaluation
```

`explore` runs one `ResearchConfiguration` (`fragment-exploration-v1`) and writes
N deterministic WAV variations plus a manifest. **No Material Entity is created**
until an explicit `retain`. Same source, configuration version and seed always
produce bit-identical bytes; different seeds produce distinct results.

A retained result is an ordinary Material and can feed the next exploration, so
genealogy accumulates across generations.

## Live test build

The app deploys automatically to GitHub Pages on every push to `main`:

**https://spuklab.github.io/spk-alchemy/**

Open it in Safari on the phone. Everything runs on the device — capture,
exploration and materials all live in IndexedDB. Nothing is uploaded, there is
no server, no account and no telemetry.

**Local data is not a backup.** Clearing Safari's website data, or removing the
Home Screen app, can erase retained materials. iOS may also evict storage from
sites it considers unused.

The **Dispositivo** section reports what this particular Safari supports:
secure context, IndexedDB, `getUserMedia`, `MediaRecorder`, the recording MIME
types it actually accepts, audio decoding, the active storage adapter and the
build id. That is the information worth reporting back when something fails.

## iPhone web app

The phone is the artistic surface; the CLI is validation and maintenance.

```bash
npm run web        # build the bundle and serve web/ on port 8788
```

Open it on the phone, then Share → Add to Home Screen. The app works offline:
capture, exploration and materials all live in IndexedDB on the device. There is
no server, no sync and no account.

**Microphone capture needs a secure context.** Plain `http://` works only on
localhost, so on a phone reach it over HTTPS or through a tunnel.

The screen has three sections: capture (record or import, listen, ingest),
exploration (pick a source, Explore, eight variations to keep or discard) and
materials (promoted, retained, rejected). Genealogy, Agents, hashes and the
Knowledge Graph are recorded but deliberately not shown — the phone should feel
like an experimental recorder, not an administrative tool.

Captured audio is normalised to canonical PCM16 WAV before hashing, analysis or
experimentation, so the recording format the device happens to offer never
reaches the domain.

## Requirements

Node **≥ 22.6**. There are **no runtime dependencies**: persistence uses the
built-in `node:sqlite`, tests use `node:test`, and TypeScript runs through native
type stripping.

Two dev dependencies exist for the browser work: `esbuild` builds the web bundle,
and `fake-indexeddb` lets the adapter conformance suite run against IndexedDB in
Node. Neither is shipped, and neither is reachable from the canonical core.

## Commands

```bash
npm run migrate    # apply migrations (deterministic from an empty store)
npm run demo       # walk the whole cycle with commentary
npm run seed       # build the 100-material corpus, then print statistics
npm run stats      # corpus statistics
npm run queries    # demonstrate the required queries
npm run audit      # integrity audit (paginated full corpus, non-interactive)
npm test           # conformance + architectural + integration tests
```

`SPK_DATA_ROOT` overrides the store location (default `.data`).
`node src/cli/main.ts reset` removes it.

## Architecture in one screen

| Layer | Responsibility |
|---|---|
| `src/core` | The five structural primitives, identity, typed errors |
| `src/persistence` | Portable `RecordStore` / `ContentStore` contracts, canonical key encoding, index declarations |
| `src/registries` | Data Registry (validity) and View Registry (presentation only) |
| `src/query` | Iterative traversal and the eleven required queries |
| `src/domain/alchemy` | Domain vocabulary and the Preview/Retain/Promote/Reject service |
| `src/adapters` | `node-sqlite` RecordStore, `content-fs` ContentStore |
| `src/migrations` | Versioned, forward-only migrations and index declarations |
| `src/cli` | Composition root and console validation |

The canonical core never imports Node, the filesystem, SQL or a storage engine.
That is enforced by a test, not by convention.

## Governing authority

The normative architecture lives in the Governance Canon repository
`SpukLab/spuklab-canon`, in `05-decisions/` (ADR-001 through ADR-009). This
repository is an implementation of those decisions and claims no independent
architectural authority. `docs/adr/` holds a project-level implementation
reference, not a normative ADR.

Structural primitives: **Entity, Relationship, Knowledge, Transition, Agent**.
Research Intent, Canonical Grouping and Published Artifact are canonical *types*
built from those primitives, never additional root structures. Canon is a query
over Knowledge whose epistemic stage is `canon` — there is no Canon store.

## Material identity

Entity UUID answers *"which laboratory object and history is this?"*.
Content hash answers *"are these audio bytes identical?"*. Two imports of the
same bytes produce two UUIDs and one hash. Duplicates are **reported, never
merged**.

## Repository limitations

- The browser (IndexedDB) adapter is not implemented; see
  `docs/BROWSER_ADAPTER_COMPATIBILITY.md` for what must not change.
- Audio support is canonical PCM16 WAV only, deliberately, so bit-for-bit
  reproducibility is a property of the format rather than of a tolerance.
- Single-user and local. No snapshot isolation is promised across concurrent
  writers; keyset pagination guarantees deterministic traversal of a stable store.
- `node:sqlite` is an experimental Node API; the adapter boundary exists so
  replacing it costs one file.
