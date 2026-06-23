const GND_BASE = "https://lobid.org/gnd";
const RECONCILE_BASE = "https://reconcile.gnd.network/gnd/reconcile/";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_FETCHES = 10;

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
  label: string;
  types: string[];
  description: string;
  score: number;
  variantNames: string[];
  url: string;
}

interface ReconcileCandidate {
  id: string;
  name: string;
  score: number;
}

export async function getGndEntry(id: string): Promise<GndEntry> {
  const url = normalizeGndUrl(id);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`lobid-gnd lookup failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<GndEntry>;
}

export async function matchGndEntities(
  terms: string[],
  limitPerTerm = 5,
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

              return {
                gndId: entry.gndIdentifier || candidate.id,
                label: entry.preferredName || candidate.name,
                types: entry.type.filter((t) => t !== "AuthorityResource"),
                description: buildDescription(entry),
                score: candidate.score,
                variantNames: entry.variantName ?? [],
                url: entry.id,
              } satisfies MatchCandidate;
            } catch (error) {
              console.error(`Failed to enrich GND candidate ${candidate.id}:`, error);
              return null;
            }
          }),
        );

        results.push(...enriched.filter((candidate): candidate is MatchCandidate => candidate !== null));
      }

      return {
        query: term,
        candidates: results,
      };
    }),
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
