import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuSearch, inferMealCategory, menuSearchDocument } from './search.js';

const menu = [
  { id: 1, name: 'Masala Dosa', category: 'Meals', canteen_id: 'IT', is_veg: true, available: true },
  { id: 2, name: 'Chicken Roll', category: 'Rolls', canteen_id: 'MBA', is_veg: false, available: true },
  { id: 3, name: 'Tea', category: 'Drinks', canteen_id: 'IT', is_veg: true, available: false },
];

test('semantic ranking finds a dish by its described use without shared query words', async () => {
  const search = createMenuSearch({
    embedTexts: async (texts) => texts.map((text) =>
      text === 'something uplifting' || text.includes('South Indian breakfast')
        ? [1, 0]
        : [0, 1]),
  });

  const results = await search('something uplifting', menu);
  assert.equal(results[0].name, 'Masala Dosa');
  assert.equal(results[0].matched_by, 'semantic-hybrid');
  assert.ok(results[0].search_score > results[1].search_score);
  assert.equal(results.some((item) => item.name === 'Tea'), false);
});

test('plain dish-name queries keep exact matches ahead of semantic neighbors', async () => {
  const search = createMenuSearch({
    embedTexts: async (texts) => texts.map((text) =>
      text === 'tea' || text.includes('South Indian breakfast')
        ? [1, 0]
        : [0, 1]),
  });

  const results = await search('tea', menu.map((item) => ({ ...item, available: true })));
  assert.equal(results[0].name, 'Tea');
  assert.equal(results[0].matched_by, 'exact-name');
  assert.equal(results.some((item) => item.available === false), false);
});

test('meal-time intent can promote an appropriate menu category', async () => {
  const search = createMenuSearch({
    embedTexts: async (texts) => texts.map((text) =>
      text === 'something for breakfast' || text.includes('Tea, a warm spiced tea')
        ? [1, 0]
        : [0.99, 0.1]),
  });

  const results = await search('something for breakfast', menu.map((item) => ({ ...item, available: true })));
  assert.equal(results[0].name, 'Masala Dosa');
  assert.equal(results[0].intent_match, 'Meals');
});

test('a meal-context query is not misclassified as a plain dish-name search', async () => {
  assert.equal(inferMealCategory('tea time snack'), 'Snacks');
  const search = createMenuSearch({
    embedTexts: async (texts) => texts.map((text) =>
      text === 'tea time snack' || text.startsWith('Tea.')
        ? [1, 0]
        : [0.99, 0.1]),
  });

  const contextualMenu = [
    ...menu.map((item) => ({ ...item, available: true })),
    { id: 4, name: 'Samosa', category: 'Snacks', canteen_id: 'MBA', is_veg: true, available: true },
  ];
  const results = await search('tea time snack', contextualMenu);
  assert.equal(results[0].category, 'Snacks');
  assert.notEqual(results.find((item) => item.name === 'Tea').matched_by, 'exact-name');
});

test('menu descriptions add food context to sparse menu names', () => {
  const document = menuSearchDocument(menu[0]).toLowerCase();
  assert.match(document, /south indian breakfast/);
  assert.match(document, /fermented rice and lentil/);
  assert.match(document, /vegetarian/);
});

test('repeated queries reuse the local query and catalog embeddings', async () => {
  let embeddingCalls = 0;
  const search = createMenuSearch({
    embedTexts: async (texts) => {
      embeddingCalls += 1;
      return texts.map(() => [1, 0]);
    },
  });

  await search('something uplifting', menu);
  await search('something uplifting', menu);
  assert.equal(embeddingCalls, 2);
});
