# CampusBite semantic dish search

This document explains the search design inspired by Swiggy's published small-language-model (SLM) work. CampusBite does **not** contain Swiggy's private model, training data, or model weights. It runs a public, pretrained MiniLM sentence encoder locally and combines semantic similarity with lexical retrieval. The two-stage Swiggy training process below is described for completeness; reproducing that fine-tuning requires search-to-order data and human-reviewed query–dish labels that this pilot does not have.

## What the reference describes

Swiggy's published system addresses food queries whose intent is clear even when the words do not appear in the dish name. For example, a search for regional sweets should retrieve relevant dishes even without a literal word match.

The case study describes a two-stage training process:

1. **Domain adaptation from behavior:** turn searches followed by purchases into short documents containing the query and purchased dish context. Use the resulting unlabelled examples for TSDAE-style denoising: remove or swap words in a document, encode the corrupted text, and train the model to reconstruct the original meaning. This helps the encoder learn food and search relationships from real behavior without manually labeling every example.
2. **Supervised query-to-dish alignment:** curate query and relevant-dish pairs, enrich dish context with attributes such as cuisine, ingredient, and preparation, then train contrastively. Each relevant dish is a positive for its query; other dishes in the training batch act as negatives. Review difficult examples and add them to later training rounds.

At serving time, encode dish documents once, encode each search query, and retrieve the closest serviceable dishes by vector similarity. Keep literal text search for ordinary dish-name queries. The article reports evaluating with Precision@1, Precision@5, and MAP, and describes a CPU latency target below 100 ms. Its reported scores and scale are Swiggy's results, **not CampusBite measurements**.

## What CampusBite implements

The running pilot is a retrieval adaptation, not a fine-tuned Swiggy replica:

- **Encoder:** `Xenova/all-MiniLM-L6-v2`, a public 384-dimensional sentence-embedding model in ONNX-compatible Transformers.js format, quantized to Q8 for local CPU inference.
- **Domain context:** `server/search.js` enriches the pilot's sparse menu records with hand-written food descriptions (for example, dosa as a South Indian breakfast; samosa as a teatime snack). New menu items receive their name, category, canteen, and dietary attributes even when no hand-written description exists.
- **Candidate scope:** the API searches only currently available items across the campus menu. That is the pilot's serviceability boundary; it is not GPS or a five-kilometre restaurant-radius calculation.
- **Query handling:** student-authenticated requests go to `GET /api/search?q=...`. Exact dish-name matches stay ahead of semantic neighbors. Other results use the hybrid ranking below. The page debounces input, shows model-loading/errors, and retains a lexical name/category fallback if semantic search is temporarily unavailable.
- **No third-party inference:** the model artifact is fetched from Hugging Face when the app first starts without a cached copy. Once present, both menu and query embeddings are computed by the application process. Search text is not sent to a hosted model API or saved as a search-history row.

### Request and model lifecycle

The server begins loading the encoder asynchronously during startup. The first uncached deployment needs internet access to download the public model files; subsequent starts reuse the local Transformers.js cache. Docker Compose mounts a named model-cache volume. While the model is not ready, the search API returns HTTP 503 with a readable message; ordering, authentication, and the rest of the app remain available.

The browser sends the query only after two characters and a 250 ms quiet period. The server validates the query, checks the short-lived Redis result cache, loads the current available menu from the existing menu cache (or PostgreSQL), then ranks candidates locally. The returned list is cached in Redis for 60 seconds under a SHA-256 key derived from the model identifier and normalized query. Menu availability/creation changes invalidate those search results. The query text is not part of the Redis cache key.

## Ranking algorithms

### 1. Text normalization and menu documents

Text is Unicode-normalized, case-folded, reduced to letters/numbers, and whitespace-normalized. Each menu item becomes a natural-language document assembled from:

```text
dish name + curated food/use description + category + diet + canteen
```

The descriptions make semantic relationships available even if a search query and dish name share no words. They are curated metadata, not model training examples.

### 2. Sentence embeddings

For each document and query, MiniLM produces a vector. Mean pooling combines token representations, and L2 normalization puts vectors on a common scale. Cosine similarity is the dot product of the normalized vectors:

```text
cosine(q, d) = q · d
semantic(q, d) = clamp((cosine(q, d) + 1) / 2, 0, 1)
```

Menu-document vectors are indexed once per menu-content hash in a bounded in-process cache. Query vectors are also kept in a bounded in-process cache to avoid recomputing repeated searches. Changing an item's searchable fields changes the catalog hash and builds a fresh index.

### 3. BM25 lexical retrieval

BM25 preserves exact-word precision and catches names, categories, and canteens. The implementation uses `k1 = 1.5` and `b = 0.75`; for each query term it applies inverse document frequency and term-frequency/length normalization:

```text
IDF(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
BM25(q, d) = Σ IDF(t) × tf(t,d) × (k1 + 1)
             / (tf(t,d) + k1 × (1 - b + b × |d| / avgdl))
```

The BM25 score is divided by the best score in the current candidate set, producing a `[0, 1]` lexical feature. If no term matches, the feature is zero.

### 4. Hybrid relevance score

For non-exact matches, the current pilot combines semantic and lexical evidence with an explicit meal-time/category feature. The latter is a small, transparent pilot rule for words such as “breakfast”, “snack”, “juice”, and “dinner”; it helps compensate for the base encoder not being fine-tuned on campus food searches:

```text
score = 0.60 × semantic(q,d)
      + 0.20 × normalized_BM25(q,d)
      + 0.08 × exact_name_match(q,d)
      + 0.12 × meal_category_intent_match(q,d)
```

Exact dish-name matches are sorted ahead of semantic neighbors, following the reference system's separation between ordinary dish-name search and broader intent search. When a meal-time intent is detected, matching menu categories are also prioritized before the hybrid score breaks ties. These weights and intent rules are pilot heuristics; they have not been tuned on a labeled CampusBite evaluation set.

## System architecture

```text
Student browser
  └─ debounced GET /api/search?q=...
       └─ Express authentication + student role check + input validation
            ├─ Redis: 60-second response cache (hashed normalized query)
            ├─ Redis: existing available-menu cache
            │    └─ PostgreSQL menu_items on cache miss
            └─ Node.js search module (local CPU inference)
                 ├─ Transformers.js / ONNX Runtime
                 │    └─ Q8 Xenova/all-MiniLM-L6-v2
                 ├─ in-process menu-document embedding index
                 ├─ in-process query-vector cache
                 ├─ cosine semantic score
                 └─ BM25 + exact-name score fusion
```

No schema migration is required. Search embeddings are derived from the current menu and cached in process; the existing Redis service caches response payloads. Menu mutation endpoints evict cached search responses. Each application replica has its own in-memory vector index; Redis allows replicas to share the short-lived final-result cache.

## Methodology to train a CampusBite-specific SLM later

The inference path is ready to use an improved compatible embedding model, but production-quality fine-tuning needs a deliberately collected and reviewed dataset:

1. **Define safe event collection.** Decide consent, retention, access, and deletion rules before logging queries. Record the minimum necessary query-to-purchased-item relationship; do not treat every impression as relevance.
2. **Build Stage 1 documents.** Join successful searches to purchased menu items and stable item context (category, cuisine, ingredients, preparation). Remove direct identifiers and split data by time/user to avoid leakage.
3. **Run TSDAE domain adaptation.** Corrupt document text through token deletion/swapping, encode the corrupted document, and optimize reconstruction of the original document representation. Keep a held-out temporal set.
4. **Curate Stage 2 pairs.** Write realistic intents for dietary needs, regional food, occasion, mood, ingredients, and meal time. Pair each query with relevant available dishes, and have a human verify the labels. Add difficult negatives such as similar names with the wrong diet or cuisine.
5. **Fine-tune contrastively.** Train query and dish representations so positives have high cosine similarity and in-batch/hard negatives have lower similarity (for example, a temperature-scaled InfoNCE loss). Balance categories and avoid repeated near-duplicate leakage.
6. **Evaluate before rollout.** Use a human-labeled, time-separated query set. Report Recall@K, Precision@1, Precision@5, MAP, no-result coverage, and p50/p95 CPU latency. Compare with exact/BM25 and the current base encoder. Do not copy the article's metrics as CampusBite results.
7. **Deploy with safeguards.** Export a compatible ONNX model, quantize only after measuring ranking loss, version the model and embedding index together, warm the model before routing traffic, and retain a rollback path. Review low-confidence or failed queries and add verified pairs in a controlled retraining cycle.

No user search history, search-to-order join, human relevance labels, fine-tuned weights, or training/evaluation pipeline is currently present in this pilot. Those are prerequisites for claiming a CampusBite-fine-tuned SLM or reporting a meaningful MAP/precision score.

## References

- [How Swiggy uses SLMs — AI Engineering Case Study #2](https://aiengg.dev/blog/how-swiggy-is-using-slms-to-improve-search)
- [Swiggy Bytes: Improving search relevance in hyperlocal food delivery using (small) language models](https://medium.com/swiggy-bytes/improving-search-relevance-in-hyperlocal-food-delivery-using-small-language-models-ecda2acc24e6)
- [CODS-COMAD 2024 paper](https://doi.org/10.1145/3632410.3632428)
- [Xenova/all-MiniLM-L6-v2 model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
