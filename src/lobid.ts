const GND_BASE = "https://lobid.org/gnd";
const RECONCILE_BASE = "https://reconcile.gnd.network/gnd/reconcile/";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_FETCHES = 10;
const MAX_VARIANT_NAMES = 5;
const MAX_BIOGRAPHICAL_ENTRIES = 2;
const MAX_TEXT_LENGTH = 240;
const MAX_ENTITY_REFERENCES = 5;
const CACHE_TTL_MS = 60 * 60 * 1000;

const gndEntryCache = new Map<string, { expiresAt: number; value: GndEntry }>();

export interface GndEntry {
  id: string;
  gndIdentifier?: string;
  preferredName?: string;
  variantName?: string[];
  type: string[];
  dateOfBirth?: string;
  dateOfDeath?: string;
  placeOfBirth?: { id: string; label: string }[];
  placeOfDeath?: { id: string; label: string }[];
  professionOrOccupation?: { id: string; label: string }[];
  biographicalOrHistoricalInformation?: string[];
  [key: string]: unknown;
}

export interface MatchCandidate {
  gndId: string;
  preferredName: string;
  type: string[];
  score: number;
  variantName: string[];
  id: string;
  summary?: string;
  confidence: "high" | "medium" | "low";
  matchSignals: string[];
}

interface ReconcileCandidate {
  id: string;
  name: string;
  score: number;
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
  const entry = (await res.json()) as GndEntry;

  const compactEntry = compactGndEntry(entry);

  gndEntryCache.set(url, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value: compactEntry,
  });

  return compactEntry;
}

export async function matchGndEntities(
  terms: string[],
  limitPerTerm = 5,
  entityTypes?: string[],
): Promise<{ query: string; candidates: MatchCandidate[] }[]> {
  const url = new URL(RECONCILE_BASE);
  url.searchParams.set(
    "queries",
    JSON.stringify(
      Object.fromEntries(
        terms.map((term, index) => [`q${index}`, { query: term, limit: limitPerTerm }]),
      ),
    ),
  );

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gnd reconcile failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as Record<
    string,
    { result: ReconcileCandidate[] }
  >;

  return Promise.all(
    terms.map(async (term, index) => {
      const candidates = data[`q${index}`]?.result ?? [];
      const results: MatchCandidate[] = [];

      for (let offset = 0; offset < candidates.length; offset += MAX_CONCURRENT_FETCHES) {
        const chunk = candidates.slice(offset, offset + MAX_CONCURRENT_FETCHES);

        const enriched = await Promise.all(
          chunk.map(async (candidate) => {
            try {
              const entry = await getGndEntry(candidate.id);

              const summary = buildSummary(entry);

              return {
                gndId: entry.gndIdentifier || candidate.id,
                preferredName: entry.preferredName || candidate.name,
                type: entry.type.filter((t) => t !== "AuthorityResource").sort(),
                score: candidate.score,
                variantName: truncateArray(entry.variantName ?? [], MAX_VARIANT_NAMES).sort(),
                id: entry.id,
                ...(summary ? { summary } : {}),
                confidence: buildConfidence(candidate.score),
                matchSignals: buildMatchSignals(entry, candidate.name),
              } satisfies MatchCandidate;
            } catch (error) {
              console.error(`Failed to enrich GND candidate ${candidate.id}:`, error);
              return null;
            }
          }),
        );

        results.push(
          ...enriched.filter(
            (candidate): candidate is MatchCandidate =>
              candidate !== null && matchesEntityTypes(candidate.type, entityTypes),
          ),
        );
      }

      return {
        query: term,
        candidates: results,
      };
    }),
  );
}

function matchesEntityTypes(candidateTypes: string[], entityTypes?: string[]): boolean {
  if (!entityTypes?.length) {
    return true;
  }

  const normalizedFilters = entityTypes.map((type) => type.toLowerCase());

  return candidateTypes.some((candidateType) =>
    normalizedFilters.some((filter) => candidateType.toLowerCase().includes(filter)),
  );
}

function normalizeGndUrl(id: string): string {
  if (!id.startsWith("http")) {
    return `${GND_BASE}/${id}.json`;
  }

  const url = new URL(id);
  const hostname = url.hostname.replace(/\.$/, "");

  if (!["lobid.org", "d-nb.info"].includes(hostname)) {
    throw new Error(`unsupported GND host: ${hostname}`);
  }

  if (!url.pathname.startsWith("/gnd/")) {
    throw new Error("only /gnd/ URLs supported");
  }

  if (url.search || url.hash) {
    throw new Error("query parameters and fragments not allowed in GND URLs");
  }

  return `${url.origin}${url.pathname.endsWith(".json") ? url.pathname : `${url.pathname}.json`}`;
}

function buildDescription(entry: GndEntry): string {
  return [
    entry.professionOrOccupation?.map((item) => item.label).join(", "),
    [entry.dateOfBirth, entry.dateOfDeath].filter(Boolean).join("-"),
  ]
    .filter(Boolean)
    .join(" | ");
}

function compactGndEntry(entry: GndEntry): GndEntry {
  return {
    ...entry,
    type: [...entry.type].sort(),
    variantName: truncateArray(entry.variantName ?? [], MAX_VARIANT_NAMES).sort(),
    biographicalOrHistoricalInformation: truncateArray(
      (entry.biographicalOrHistoricalInformation ?? []).map(truncateText),
      MAX_BIOGRAPHICAL_ENTRIES,
    ),
    professionOrOccupation: truncateArray(entry.professionOrOccupation ?? [], MAX_ENTITY_REFERENCES),
    placeOfBirth: truncateArray(entry.placeOfBirth ?? [], MAX_ENTITY_REFERENCES),
    placeOfDeath: truncateArray(entry.placeOfDeath ?? [], MAX_ENTITY_REFERENCES),
    summary: buildSummary(entry),
  };
}

function buildSummary(entry: GndEntry): string | undefined {
  const summary = [
    buildDescription(entry),
    truncateArray(entry.biographicalOrHistoricalInformation ?? [], MAX_BIOGRAPHICAL_ENTRIES).join(" | "),
  ]
    .filter(Boolean)
    .join(" | ");

  return truncateText(summary);
}

function buildConfidence(score: number): MatchCandidate["confidence"] {
  if (score >= 90) {
    return "high";
  }

  if (score >= 60) {
    return "medium";
  }

  return "low";
}

function buildMatchSignals(entry: GndEntry, candidateName: string): string[] {
  const signals: string[] = [];

  if (entry.preferredName?.toLowerCase() === candidateName.toLowerCase()) {
    signals.push("exact preferred name");
  }

  if (entry.variantName?.length) {
    signals.push("variant names available");
  }

  if (entry.type.some((type) => type !== "AuthorityResource")) {
    signals.push("entity type available");
  }

  if (entry.dateOfBirth || entry.dateOfDeath) {
    signals.push("lifespan available");
  }

  return signals;
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
