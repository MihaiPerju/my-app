export type Bm25SearchDocument<T> =
  | Bm25SearchTextDocument<T>
  | Bm25SearchFieldDocument<T>;

export type Bm25SearchTextDocument<T> = {
  document: T;
  text: string;
};

export type Bm25SearchFieldDocument<T> = {
  document: T;
  fields: readonly Bm25SearchField[];
};

export type Bm25SearchField = {
  text: string;
  weight?: number;
};

export type Bm25SearchResult<T> = {
  document: T;
  score: number;
};

export type Bm25Tokenizer = (text: string) => string[];

export type Bm25SearchIndex<T> = {
  documentCount: number;
  documents: readonly T[];
  search: (params: Bm25SearchParams<T>) => Bm25SearchResult<T>[];
};

export type Bm25SearchParams<T> = {
  query: string;
  limit?: number;
  compareDocuments?: (left: T, right: T) => number;
};

type Bm25SearchIndexOptions = {
  b?: number;
  k1?: number;
  tokenize?: Bm25Tokenizer;
};

type Bm25Posting = {
  documentIndex: number;
  weight: number;
};

type DocumentTermFrequencies = {
  length: number;
  termFrequencies: Map<string, number>;
  fieldWeights: Map<string, number>;
};

type InternalBm25SearchIndex<T> = Bm25SearchIndex<T> & {
  idfByToken: Map<string, number>;
  postingsByToken: Map<string, Bm25Posting[]>;
  tokenize: Bm25Tokenizer;
};

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

/**
 * Tokenizer tuned for TypeScript-ish identifiers and natural-language text.
 * It splits camelCase before lowercasing so `searchToolFunctions` can match
 * `search tool functions`.
 */
export function tokenizeBm25Text(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function createBm25SearchIndex<T>(
  documents: readonly Bm25SearchDocument<T>[],
  options: Bm25SearchIndexOptions = {},
): Bm25SearchIndex<T> {
  const tokenize = options.tokenize ?? tokenizeBm25Text;
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const indexedDocuments: T[] = [];
  const docFrequenciesByDocument: DocumentTermFrequencies[] = [];
  const documentLengths: number[] = [];
  let totalDocumentLength = 0;

  for (const document of documents) {
    const docFrequencies = buildDocumentTermFrequencies({
      document,
      tokenize,
    });

    indexedDocuments.push(document.document);
    docFrequenciesByDocument.push(docFrequencies);
    documentLengths.push(docFrequencies.length);
    totalDocumentLength += docFrequencies.length;
  }

  const documentCount = indexedDocuments.length;
  const averageDocumentLength =
    documentCount === 0 ? 0 : totalDocumentLength / documentCount;
  const postingsByToken = new Map<string, Bm25Posting[]>();

  for (let documentIndex = 0; documentIndex < documentCount; documentIndex++) {
    const docFrequencies = docFrequenciesByDocument[documentIndex];
    if (!docFrequencies) {
      continue;
    }

    const { termFrequencies, fieldWeights } = docFrequencies;
    const lengthRatio =
      averageDocumentLength === 0
        ? 0
        : (documentLengths[documentIndex] ?? 0) / averageDocumentLength;
    const lengthNormalization = k1 * (1 - b + b * lengthRatio);

    for (const [token, termFrequency] of termFrequencies) {
      const postings = postingsByToken.get(token);
      const fieldWeight = fieldWeights.get(token) ?? 1;
      const posting = {
        documentIndex,
        weight:
          fieldWeight *
          ((termFrequency * (k1 + 1)) / (termFrequency + lengthNormalization)),
      };

      if (postings) {
        postings.push(posting);
        continue;
      }

      postingsByToken.set(token, [posting]);
    }
  }

  const idfByToken = new Map<string, number>();
  for (const [token, postings] of postingsByToken) {
    const documentFrequency = postings.length;
    idfByToken.set(
      token,
      Math.log(
        1 +
          (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
      ),
    );
  }

  const index: InternalBm25SearchIndex<T> = {
    documentCount,
    documents: indexedDocuments,
    idfByToken,
    postingsByToken,
    search: (params) => searchBm25(index, params),
    tokenize,
  };

  return index;
}

function buildDocumentTermFrequencies<T>({
  document,
  tokenize,
}: {
  document: Bm25SearchDocument<T>;
  tokenize: Bm25Tokenizer;
}): DocumentTermFrequencies {
  const termFrequencies = new Map<string, number>();
  const fieldWeights = new Map<string, number>();
  let length = 0;

  if ("text" in document) {
    length += addFieldTerms({
      field: { text: document.text },
      fieldWeights,
      termFrequencies,
      tokenize,
    });
  } else {
    for (const field of document.fields) {
      length += addFieldTerms({
        field,
        fieldWeights,
        termFrequencies,
        tokenize,
      });
    }
  }

  return {
    fieldWeights,
    length,
    termFrequencies,
  };
}

function addFieldTerms({
  field,
  fieldWeights,
  termFrequencies,
  tokenize,
}: {
  field: Bm25SearchField;
  fieldWeights: Map<string, number>;
  termFrequencies: Map<string, number>;
  tokenize: Bm25Tokenizer;
}): number {
  const weight = field.weight ?? 1;
  if (weight <= 0) {
    return 0;
  }

  const tokens = tokenize(field.text);
  for (const token of tokens) {
    termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    fieldWeights.set(token, Math.max(fieldWeights.get(token) ?? 1, weight));
  }

  return tokens.length;
}

export function searchBm25<T>(
  index: Bm25SearchIndex<T>,
  params: Bm25SearchParams<T>,
): Bm25SearchResult<T>[] {
  // The only way to obtain a Bm25SearchIndex<T> is through createBm25SearchIndex,
  // which always constructs an InternalBm25SearchIndex<T> before upcasting it at
  // the return site. This downcast is therefore always safe.
  const internalIndex = index as InternalBm25SearchIndex<T>;
  if (internalIndex.documentCount === 0) {
    return [];
  }

  const queryTokens = [...new Set(internalIndex.tokenize(params.query))];
  if (queryTokens.length === 0) {
    return [];
  }

  const scores = new Float64Array(internalIndex.documentCount);
  const touchedDocumentIndexes: number[] = [];

  for (const token of queryTokens) {
    const postings = internalIndex.postingsByToken.get(token);
    if (!postings) {
      continue;
    }

    const idf = internalIndex.idfByToken.get(token);
    if (idf === undefined) {
      continue;
    }

    for (const posting of postings) {
      const currentScore = scores[posting.documentIndex] ?? 0;
      if (currentScore === 0) {
        touchedDocumentIndexes.push(posting.documentIndex);
      }
      scores[posting.documentIndex] = currentScore + idf * posting.weight;
    }
  }

  if (touchedDocumentIndexes.length === 0) {
    return [];
  }

  const limit = params.limit ?? touchedDocumentIndexes.length;
  if (limit <= 0) {
    return [];
  }

  const sortedDocumentIndexes = touchedDocumentIndexes
    .sort((left, right) =>
      compareScoredDocumentIndexes({
        compareDocuments: params.compareDocuments,
        documents: internalIndex.documents,
        left,
        right,
        scores,
      }),
    )
    .slice(0, limit);

  return sortedDocumentIndexes.map((documentIndex) => ({
    document: internalIndex.documents[documentIndex] as T,
    score: scores[documentIndex] ?? 0,
  }));
}

function compareScoredDocumentIndexes<T>({
  compareDocuments,
  documents,
  left,
  right,
  scores,
}: {
  compareDocuments: ((left: T, right: T) => number) | undefined;
  documents: readonly T[];
  left: number;
  right: number;
  scores: Float64Array;
}): number {
  const scoreComparison = (scores[right] ?? 0) - (scores[left] ?? 0);
  if (scoreComparison !== 0) {
    return scoreComparison;
  }

  const leftDocument = documents[left];
  const rightDocument = documents[right];
  if (leftDocument !== undefined && rightDocument !== undefined) {
    const documentComparison = compareDocuments?.(leftDocument, rightDocument);
    if (documentComparison !== undefined && documentComparison !== 0) {
      return documentComparison;
    }
  }

  return left - right;
}
