const GND_BASE = "https://lobid.org/gnd";
const RECONCILE_URL = "https://reconcile.gnd.network/gnd/reconcile/";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_FETCHES = 10;
const MAX_VARIANT_NAMES = 5;
const MAX_BIOGRAPHICAL_ENTRIES = 2;
const MAX_TEXT_LENGTH = 240;
const MAX_ENTITY_REFERENCES = 5;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/** GND identifiers are digits plus an optional `X` check character and hyphens, e.g. `118540238`, `4074335-4`. */
const GND_ID_PATTERN = /^[0-9]+[0-9X]?(-[0-9X])?$/i;

const gndEntryCache = new Map<string, { expiresAt: number; value: GndEntry }>();

export interface EntityRef {
  id: string;
  label: string;
}

/** The upstream lobid record. It carries ~40 fields; we deliberately keep only a few. */
interface RawGndEntry {
  id?: string;
  gndIdentifier?: string;
  preferredName?: string;
  variantName?: string[];
  type?: string[];
  dateOfBirth?: string[];
  dateOfDeath?: string[];
  placeOfBirth?: EntityRef[];
  placeOfDeath?: EntityRef[];
  professionOrOccupation?: EntityRef[];
  biographicalOrHistoricalInformation?: string[];
}

/**
 * The compact record handed to the model. This is an allowlist, not the upstream
 * record with a few fields trimmed: lobid ships blobs like `sameAs` and
 * `variantNameEntityForThePerson` that cost thousands of tokens and add nothing
 * to reconciliation.
 */
export interface GndEntry {
  id: string;
  gndIdentifier?: string;
  preferredName?: string;
  type?: string[];
  variantName?: string[];
  dateOfBirth?: string[];
  dateOfDeath?: string[];
  placeOfBirth?: EntityRef[];
  placeOfDeath?: EntityRef[];
  professionOrOccupation?: EntityRef[];
  biographicalOrHistoricalInformation?: string[];
  summary?: string;
}

export interface MatchCandidate {
  gndId: string;
  preferredName: string;
  type: string[];
  score: number;
  confidence: "high" | "medium" | "low";
  matchSignals: string[];
  variantName?: string[];
  summary?: string;
}

interface ReconcileCandidate {
  id: string;
  name: string;
  score: number;
  match?: boolean;
}

export async function getGndEntry(id: string): Promise<GndEntry> {
  const url = normalizeGndUrl(id);

  const cached = gndEntryCache.get(url);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`lobid-gnd lookup failed: ${res.status} ${res.statusText}`);
  }

  const compactEntry = compactGndEntry((await res.json()) as RawGndEntry, url);

  cacheEntry(url, compactEntry);

  return compactEntry;
}

/**
 * Fetches many records without letting one bad identifier discard the good ones —
 * failures are reported per id instead of rejecting the whole batch.
 */
export async function getGndEntries(
  ids: string[],
): Promise<{ records: GndEntry[]; errors: { id: string; message: string }[] }> {
  type Settled = { id: string; entry: GndEntry } | { id: string; message: string };

  const records: GndEntry[] = [];
  const errors: { id: string; message: string }[] = [];

  // Dedupe on the canonical URL, so `118540238` and its d-nb.info URL are one
  // lookup rather than the same record twice.
  const targets = new Map<string, string>();

  for (const id of new Set(ids.map((id) => id.trim()))) {
    try {
      const url = normalizeGndUrl(id);

      if (!targets.has(url)) {
        targets.set(url, id);
      }
    } catch (error) {
      errors.push({ id, message: toMessage(error) });
    }
  }

  const settled = await pooledMap<string, Settled>(
    [...targets.values()],
    MAX_CONCURRENT_FETCHES,
    async (id) => {
      try {
        return { id, entry: await getGndEntry(id) };
      } catch (error) {
        return { id, message: toMessage(error) };
      }
    },
  );

  for (const item of settled) {
    if ("entry" in item) {
      records.push(item.entry);
    } else {
      errors.push({ id: item.id, message: item.message });
    }
  }

  return { records, errors };
}

export async function matchGndEntities(
  terms: string[],
  limitPerTerm = 5,
  entityTypes?: string[],
): Promise<{ query: string; candidates: MatchCandidate[] }[]> {
  // The reconcile API filters by type itself, but only one type per query, so a
  // caller asking for several types becomes several queries. Filtering upstream
  // is what makes `limitPerTerm` mean "this many matching candidates".
  const types = entityTypes?.length ? entityTypes : [undefined];
  const jobs = terms.flatMap((term, termIndex) =>
    types.map((type, typeIndex) => ({
      term,
      termIndex,
      type,
      key: `q${termIndex}_${typeIndex}`,
    })),
  );

  const queries = Object.fromEntries(
    jobs.map((job) => [
      job.key,
      { query: job.term, limit: limitPerTerm, ...(job.type ? { type: job.type } : {}) },
    ]),
  );

  // POST, because a GET query string overflows well before the 50 terms the schema allows.
  const res = await fetch(RECONCILE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ queries: JSON.stringify(queries) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gnd reconcile failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as Record<string, { result?: ReconcileCandidate[] } | undefined>;

  // Merge each term's per-type result sets, keeping the best score per record.
  const byTerm = terms.map(() => new Map<string, ReconcileCandidate>());

  for (const job of jobs) {
    for (const candidate of data[job.key]?.result ?? []) {
      const seen = byTerm[job.termIndex]!.get(candidate.id);

      if (!seen || candidate.score > seen.score) {
        byTerm[job.termIndex]!.set(candidate.id, candidate);
      }
    }
  }

  const selected = byTerm.map((candidates) =>
    [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limitPerTerm),
  );

  // One pool across every term. Chunking per term let `terms` multiply the
  // concurrency, so 20 terms meant 200 simultaneous requests to lobid.
  const pending = selected.flatMap((candidates, termIndex) =>
    candidates.map((candidate) => ({ candidate, termIndex })),
  );

  const enriched = await pooledMap(pending, MAX_CONCURRENT_FETCHES, async ({ candidate, termIndex }) => {
    try {
      const entry = await getGndEntry(candidate.id);
      const topScore = selected[termIndex]![0]?.score ?? 0;

      return { termIndex, candidate: toMatchCandidate(entry, candidate, terms[termIndex]!, topScore) };
    } catch (error) {
      console.error(`Failed to enrich GND candidate ${candidate.id}:`, error);
      return { termIndex, candidate: null };
    }
  });

  const grouped = terms.map(() => [] as MatchCandidate[]);

  for (const item of enriched) {
    if (item.candidate) {
      grouped[item.termIndex]!.push(item.candidate);
    }
  }

  return terms.map((term, index) => ({ query: term, candidates: grouped[index]! }));
}

function toMatchCandidate(
  entry: GndEntry,
  candidate: ReconcileCandidate,
  term: string,
  topScore: number,
): MatchCandidate {
  const matchSignals = buildMatchSignals(entry, term);

  const result: MatchCandidate = {
    gndId: entry.gndIdentifier || candidate.id,
    preferredName: entry.preferredName || candidate.name,
    type: (entry.type ?? []).filter((type) => type !== "AuthorityResource"),
    score: candidate.score,
    confidence: buildConfidence(candidate.match, matchSignals.length > 0, candidate.score, topScore),
    matchSignals,
  };

  if (entry.variantName?.length) {
    result.variantName = entry.variantName;
  }

  if (entry.summary) {
    result.summary = entry.summary;
  }

  return result;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown lookup error";
}

/** Runs `fn` over every item with a single global concurrency budget. */
async function pooledMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]!);
    }
  });

  await Promise.all(workers);

  return results;
}

function cacheEntry(url: string, value: GndEntry): void {
  // Map iterates in insertion order, so the first key is the oldest entry.
  if (gndEntryCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = gndEntryCache.keys().next().value;

    if (oldest !== undefined) {
      gndEntryCache.delete(oldest);
    }
  }

  gndEntryCache.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

/**
 * Resolves any accepted identifier form to the lobid JSON URL.
 *
 * Records carry `https://d-nb.info/gnd/<id>` as their canonical URI, so models
 * hand that back to us — but d-nb.info does not serve lobid's JSON, so it is
 * mapped onto lobid here. Normalising every form to one URL also keeps the cache
 * from storing the same record several times.
 */
function normalizeGndUrl(id: string): string {
  const trimmed = id.trim();

  if (!/^https?:\/\//i.test(trimmed)) {
    if (!GND_ID_PATTERN.test(trimmed)) {
      throw new Error(`invalid GND identifier: ${trimmed}`);
    }

    return `${GND_BASE}/${trimmed}.json`;
  }

  const url = new URL(trimmed);
  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();

  if (!["lobid.org", "d-nb.info"].includes(hostname)) {
    throw new Error(`unsupported GND host: ${hostname}`);
  }

  if (url.search || url.hash) {
    throw new Error("query parameters and fragments not allowed in GND URLs");
  }

  const gndId = /^\/gnd\/([^/]+?)(?:\.json)?$/.exec(url.pathname)?.[1];

  if (!gndId || !GND_ID_PATTERN.test(gndId)) {
    throw new Error(`unsupported GND URL: ${trimmed}`);
  }

  return `${GND_BASE}/${gndId}.json`;
}

function buildDescription(entry: RawGndEntry): string {
  const lifespan = [entry.dateOfBirth?.[0], entry.dateOfDeath?.[0]].filter(Boolean).join(" – ");

  return [entry.professionOrOccupation?.map((item) => item.label).join(", "), lifespan]
    .filter(Boolean)
    .join(" | ");
}

function compactGndEntry(entry: RawGndEntry, url: string): GndEntry {
  return dropEmpty({
    id: entry.id ?? url,
    gndIdentifier: entry.gndIdentifier,
    preferredName: entry.preferredName,
    type: [...(entry.type ?? [])].sort(),
    variantName: truncateArray(entry.variantName ?? [], MAX_VARIANT_NAMES).sort(),
    dateOfBirth: entry.dateOfBirth,
    dateOfDeath: entry.dateOfDeath,
    placeOfBirth: truncateArray(entry.placeOfBirth ?? [], MAX_ENTITY_REFERENCES),
    placeOfDeath: truncateArray(entry.placeOfDeath ?? [], MAX_ENTITY_REFERENCES),
    professionOrOccupation: truncateArray(entry.professionOrOccupation ?? [], MAX_ENTITY_REFERENCES),
    biographicalOrHistoricalInformation: truncateArray(
      (entry.biographicalOrHistoricalInformation ?? []).map(truncateText),
      MAX_BIOGRAPHICAL_ENTRIES,
    ),
    summary: buildSummary(entry),
  });
}

/** `JSON.stringify` already drops `undefined`; empty arrays are pure token waste. */
function dropEmpty<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0),
    ),
  ) as T;
}

function buildSummary(entry: RawGndEntry): string | undefined {
  const summary = [
    buildDescription(entry),
    truncateArray(entry.biographicalOrHistoricalInformation ?? [], MAX_BIOGRAPHICAL_ENTRIES).join(" | "),
  ]
    .filter(Boolean)
    .join(" | ");

  return summary ? truncateText(summary) : undefined;
}

/**
 * Reconcile scores are unbounded Lucene relevance values that are only
 * comparable inside a single query — 86 can be the best possible hit for one
 * term and mediocre for another. So rank against that query's best hit and
 * against the API's own `match` flag, never against absolute thresholds.
 */
function buildConfidence(
  match: boolean | undefined,
  exactName: boolean,
  score: number,
  topScore: number,
): MatchCandidate["confidence"] {
  if (match || exactName) {
    return "high";
  }

  return topScore > 0 && score / topScore >= 0.95 ? "medium" : "low";
}

/** Signals describe how the record relates to the *query*; record completeness says nothing about match quality. */
function buildMatchSignals(entry: GndEntry, term: string): string[] {
  const needle = term.trim().toLowerCase();

  if (entry.preferredName?.trim().toLowerCase() === needle) {
    return ["exact preferred name"];
  }

  if (entry.variantName?.some((name) => name.trim().toLowerCase() === needle)) {
    return ["exact variant name"];
  }

  return [];
}

function truncateArray<T>(items: T[], limit: number): T[] {
  return items.slice(0, limit);
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}
