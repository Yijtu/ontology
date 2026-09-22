# X-03 — DuckDB ↔ PostgreSQL normalised-result equivalence

## Purpose

Verification plan item **X-03** (`tasks/spec-v0.2/verification-plan.md`) requires that the
same business query over the same logical dataset produces **equal normalised results**
in DuckDB and PostgreSQL, with dialect differences confined to the adapters
(SPEC §1 ADR-06, §2.1 INV-01..10, C3.1).

## Normalisation contract

Both adapters implement `StructuredQueryPort` and must return canonical columns and
canonical values. The contract (implemented for DuckDB in
`packages/adapters/data-duckdb/src/normalise.ts`):

| Logical value | Canonical form |
|---|---|
| integer | JS `number` when exactly representable, otherwise an exact decimal string |
| decimal / numeric | exact decimal string, never a lossy double |
| float / double | JS `number`, or `"NaN"`/`"Infinity"`/`"-Infinity"` when not finite |
| boolean | JS `boolean` |
| string / uuid / enum | JS `string` |
| date / timestamp | RFC3339 UTC with millisecond precision; `DATE` is UTC midnight |
| time / interval | engine canonical text form |
| binary | base64 string |
| list / struct / map | JSON value with object keys sorted |
| `NULL` | `null` |

Canonical column types are the contract's `ColumnType` union (`string`, `integer`,
`decimal`, `boolean`, `timestamp`, `json`, `binary`). No dialect type name may appear in
a response.

`SourceSnapshot.resultDigest` is `sha256` over the canonical JSON of
`{ columns: [{ name, type }], rows }` with object keys sorted. Equal normalised results
therefore produce an equal digest, which is the machine-checkable form of this criterion.

The consistency level reported on the snapshot is the level the backend can actually
provide (`C3.1`: "跨后端不假定全局快照"). DuckDB reports `repeatable_read` for the
per-query read-only transaction; a file-backed read-only instance reports `immutable`.

## Fixture

- Dataset: `x03-dataset.json` — one logical relation `readings`
  (`reading_id`, `meter_id`, `recorded_at`, `energy_kwh`, `quality_flag`, `is_estimated`).
- Query + expected normalised result: `x03-expected.json`.

The PostgreSQL side of the comparison creates the same logical dataset with
`NUMERIC(18,4)` / `TIMESTAMPTZ` columns and runs the same query with the same
parameters. `TIMESTAMPTZ` is used on both sides so the canonical instant is unambiguous
and does not depend on the host time zone.

## Status

**Verified.** The PostgreSQL data adapter (LOCAL-012 / #43) has landed on `main`, so the
live cross-engine comparison runs in
`tests/integration/x03-cross-engine-equivalence.spec.ts`:

1. the same logical fixture (`x03-dataset.json`) is materialised into DuckDB and created
   as a real `public.readings` table in a PostgreSQL container;
2. both adapters run the same logical query (the only difference is `?` vs `$n`
   placeholders) through the real engines;
3. `columns`, `rows` and `snapshot.resultDigest` are asserted equal, and both equal the
   committed `x03-expected.json`;
4. `tests/integration/duckdb-postgres-equivalence.spec.ts` additionally checks the
   DuckDB side against an independently computed digest.

If Docker is unavailable, the cross-engine file fails (real-DB acceptance is not replaced
by a mock); the DuckDB-side fixture test remains runnable.
