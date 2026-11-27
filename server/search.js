import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

export const SEARCH_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MAX_INDEXES = 3;
const MAX_QUERY_EMBEDDINGS = 256;
const profiles = {
  'chicken roll': 'A spicy chicken wrap in flatbread. Savoury street food, grilled chicken, protein-rich, quick non-vegetarian snack or lunch.',
  'masala dosa': 'A South Indian breakfast of a crispy fermented rice and lentil crepe with spiced potato, served with chutney and sambar. Savoury vegetarian meal.',
  'paneer roll': 'A vegetarian Indian wrap filled with paneer cottage cheese, spices and vegetables. Protein-rich, savoury street food, quick snack or lunch.',
  'veg sandwich': 'A light vegetarian snack made with bread and vegetables. A quick, fresh lunch or evening bite.',
  'veg fried rice': 'Indo-Chinese rice stir-fried with vegetables. A savoury, filling vegetarian lunch or dinner.',
  'fried rice': 'Indo-Chinese rice stir-fried with vegetables. A savoury, filling vegetarian lunch or dinner.',
  samosa: 'A crisp, savoury Indian pastry filled with spiced potato and peas. A vegetarian teatime and evening snack, often eaten with chai.',
  'lime juice': 'A refreshing lime and lemon drink. Cool, tangy, hydrating beverage for a hot day.',
  tea: 'Indian chai, a warm spiced tea drink. A comforting beverage and classic pairing for an evening snack.',
};

let modelPromise;
let modelState = 'not_loaded';
let inferenceQueue = Promise.resolve();

env.cacheDir = process.env.MODEL_CACHE_DIR ||
  path.join(os.homedir(), '.cache', 'campusbite', 'transformers');

export function getSearchModelState() {
  return modelState;
}

export function warmSearchModel() {
  if (!modelPromise) {
    modelState = 'loading';
    modelPromise = pipeline('feature-extraction', SEARCH_MODEL_ID, { dtype: 'q8' })
      .then((extractor) => {
        modelState = 'ready';
        return extractor;
      })
      .catch((error) => {
        modelState = 'failed';
        modelPromise = undefined;
        throw error;
      });
  }
  return modelPromise;
}

function encodeTexts(texts) {
  const task = inferenceQueue.then(async () => {
    const extractor = await warmSearchModel();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const vectors = output.tolist();
    return Array.isArray(vectors[0]) ? vectors : [vectors];
  });
  inferenceQueue = task.catch(() => {});
  return task;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

export function inferMealCategory(query) {
  const text = ` ${normalizeText(query)} `;
  if (/\b(breakfast|brunch|morning)\b/u.test(text)) return 'Meals';
  if (/\b(snack|snacks|teatime|evening)\b/u.test(text) || text.includes(' tea time ')) return 'Snacks';
  if (/\b(drink|drinks|juice|beverage|thirsty)\b/u.test(text)) return 'Drinks';
  if (/\b(lunch|dinner|meal|meals)\b/u.test(text)) return 'Meals';
  return null;
}

export function menuSearchDocument(item) {
  const name = normalizeText(item.name);
  const profile = profiles[name] || `${item.name} ${item.category} campus food.`;
  const diet = item.is_veg ? 'vegetarian veg plant based' : 'non vegetarian non veg';
  return `${item.name}. ${profile} Category: ${item.category}. ${diet}. Canteen: ${item.canteen_id}.`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cosineSimilarity(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function bm25Scores(queryTokens, documents) {
  const tokenizedDocuments = documents.map(tokenize);
  const averageLength = tokenizedDocuments.reduce((sum, tokens) => sum + tokens.length, 0) /
    Math.max(tokenizedDocuments.length, 1);
  const documentFrequencies = new Map();
  for (const tokens of tokenizedDocuments) {
    for (const token of new Set(tokens)) {
      documentFrequencies.set(token, (documentFrequencies.get(token) || 0) + 1);
    }
  }

  return tokenizedDocuments.map((tokens) => {
    const frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) || 0;
      if (!frequency) continue;
      const documentFrequency = documentFrequencies.get(token) || 0;
      const inverseFrequency = Math.log(1 + (documents.length - documentFrequency + 0.5) /
        (documentFrequency + 0.5));
      score += inverseFrequency * frequency * 2.5 /
        (frequency + 1.5 * (1 - 0.75 + 0.75 * tokens.length / Math.max(averageLength, 1)));
    }
    return score;
  });
}

export function createMenuSearch({ embedTexts = encodeTexts } = {}) {
  const indexCache = new Map();
  const queryCache = new Map();

  async function getIndex(items, documents) {
    const key = hash(items.map((item, index) => `${item.id}:${documents[index]}`).join('\n'));
    if (indexCache.has(key)) {
      const value = indexCache.get(key);
      indexCache.delete(key);
      indexCache.set(key, value);
      return value;
    }

    const value = Promise.resolve(embedTexts(documents));
    indexCache.set(key, value);
    while (indexCache.size > MAX_INDEXES) indexCache.delete(indexCache.keys().next().value);
    try {
      return await value;
    } catch (error) {
      indexCache.delete(key);
      throw error;
    }
  }

  async function getQueryEmbedding(query) {
    const key = normalizeText(query);
    if (queryCache.has(key)) {
      const value = queryCache.get(key);
      queryCache.delete(key);
      queryCache.set(key, value);
      return value;
    }
    const value = Promise.resolve(embedTexts([query])).then((vectors) => vectors[0]);
    queryCache.set(key, value);
    while (queryCache.size > MAX_QUERY_EMBEDDINGS) queryCache.delete(queryCache.keys().next().value);
    try {
      return await value;
    } catch (error) {
      queryCache.delete(key);
      throw error;
    }
  }

  return async function searchMenuItems(query, items) {
    const availableItems = items.filter((item) => item.available !== false);
    if (!availableItems.length) return [];
    const documents = availableItems.map(menuSearchDocument);
    const [itemVectors, queryVector] = await Promise.all([
      getIndex(availableItems, documents),
      getQueryEmbedding(query),
    ]);
    const lexicalScores = bm25Scores(tokenize(query), documents);
    const maxLexicalScore = lexicalScores.reduce((maximum, score) => Math.max(maximum, score), 0);
    const intendedCategory = inferMealCategory(query);

    return availableItems.map((item, index) => {
      const semanticScore = Math.max(0, Math.min(1, (cosineSimilarity(queryVector, itemVectors[index]) + 1) / 2));
      const lexicalScore = maxLexicalScore ? lexicalScores[index] / maxLexicalScore : 0;
      const queryText = normalizeText(query);
      const name = normalizeText(item.name);
      const queryTokens = tokenize(query);
      const nameTokens = tokenize(name);
      const exactName = queryText === name ||
        (queryTokens.length > 1 && queryTokens.length <= 2 &&
          queryTokens.every((token) => nameTokens.includes(token)));
      const mealIntentMatch = intendedCategory !== null && item.category === intendedCategory;
      const score = 0.60 * semanticScore + 0.20 * lexicalScore +
        0.08 * Number(exactName) + 0.12 * Number(mealIntentMatch);
      return {
        ...item,
        search_score: Math.round(score * 10000) / 10000,
        matched_by: exactName ? 'exact-name' : 'semantic-hybrid',
        ...(mealIntentMatch ? { intent_match: intendedCategory } : {}),
      };
    }).sort((left, right) =>
      Number(right.matched_by === 'exact-name') - Number(left.matched_by === 'exact-name') ||
      Number(Boolean(right.intent_match)) - Number(Boolean(left.intent_match)) ||
      right.search_score - left.search_score);
  };
}

export const searchMenuItems = createMenuSearch();
