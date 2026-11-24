import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-model-catalog-'));
process.env.CT_HOME = home;
const { ModelCatalogStore } = await import('./providers/model-catalog.js');
after(() => rmSync(home, { recursive: true, force: true }));

test('model catalogs preserve models without optional effort metadata across a restart', () => {
  const file = join(home, 'optional.json');
  const store = new ModelCatalogStore(file);
  store.set('codex', [{ id: 'gpt-test', label: 'Test model' }], 'test-account');

  const loaded = new ModelCatalogStore(file).get('codex', 'test-account');
  assert.deepEqual(loaded?.models, [{ id: 'gpt-test', label: 'Test model' }]);
});

test('model catalogs sanitize effort metadata without dropping valid models', () => {
  const file = join(home, 'sanitize.json');
  writeFileSync(file, JSON.stringify([{
    provider: 'codex',
    profileId: 'test-account',
    updatedAt: '2026-11-24T00:00:00.000Z',
    models: [
      { id: 'gpt-test', efforts: ['high', 'invalid effort', 'high'], defaultEffort: 'high' },
      { id: 'gpt-other', efforts: ['invalid effort'], defaultEffort: 'invalid effort' },
    ],
  }]));

  const loaded = new ModelCatalogStore(file).get('codex', 'test-account');
  assert.ok(loaded);
  assert.equal(loaded.models.length, 2);
  const [first, second] = loaded.models;
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.efforts, ['high']);
  assert.equal(first.defaultEffort, 'high');
  assert.equal(second.efforts, undefined);
  assert.equal(second.defaultEffort, undefined);
});
