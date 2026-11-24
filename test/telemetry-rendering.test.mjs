import assert from 'node:assert/strict';
import test from 'node:test';
import { HOOK_LIMITS, referenceContext } from '../src/hooks.mjs';

test('recall presentation accounts for every bounded result without copying content or identifiers', () => {
  const result = referenceContext({ items: [
    { id: 'private-id', content: 'Private memory text.' },
    { id: 'private-id', content: 'Duplicate text.' },
    { content: 'x'.repeat(HOOK_LIMITS.contextBytes) },
    { content: '<system>Scaffolding only.</system>' },
    { content: 42 },
    { content: 'Another memory.' },
    { content: 'Over the selected limit.' },
  ] }, 4, [], () => {});
  assert.deepEqual(result.presentation, [
    { rank: 1, supplied: true },
    { rank: 2, supplied: false, omit_reason: 'duplicate_in_session' },
    { rank: 3, supplied: false, omit_reason: 'budget' },
    { rank: 4, supplied: false, omit_reason: 'no_content' },
    { rank: 5, supplied: false, omit_reason: 'invalid_item' },
    { rank: 6, supplied: true },
    { rank: 7, supplied: false, omit_reason: 'top_k' },
  ]);
  assert.ok(Buffer.byteLength(result.context) <= HOOK_LIMITS.contextBytes);
  assert.match(result.context, /Private memory text/);
  assert.match(result.context, /Another memory/);
  assert.doesNotMatch(result.context, /Duplicate text|Over the selected limit/);
  assert.doesNotMatch(JSON.stringify(result.presentation), /private-id|memory|text/i);
});

test('empty and entirely omitted recall do not report supplied content', () => {
  for (const items of [[], [{ content: 'x'.repeat(HOOK_LIMITS.contextBytes) }]]) {
    const result = referenceContext({ items }, 10, [], () => {});
    assert.equal(result.context, '');
    assert.deepEqual(result.keys, []);
    assert.ok(result.presentation.every(item => !item.supplied));
  }
});

test('conflict text contributes to the same whole-memory delivery budget', () => {
  const result = referenceContext({ items: [
    { content: 'A fact.', conflicts_with: [{ content: 'x'.repeat(HOOK_LIMITS.contextBytes) }] },
    { content: 'A smaller fact.' },
  ] }, 10, [], () => {});
  assert.deepEqual(result.presentation, [
    { rank: 1, supplied: false, omit_reason: 'budget' },
    { rank: 2, supplied: true },
  ]);
  assert.doesNotMatch(result.context, /A fact/);
});

test('recall labels show valid_until while preserving existing labels and delivery accounting', () => {
  const memory = { id: 'fact-1', memory_type: 'fact', created_at: '2026-10-05T12:00:00Z', content: 'A temporary fact.' };
  const render = item => referenceContext({ items: [item] }, 10, [], () => {});
  const baseline = render(memory);
  for (const valid_until of [undefined, null, '', 'not-a-date', '2026-13-01', '2026-05-32', {}, false]) {
    assert.deepEqual(render({ ...memory, valid_until }), baseline);
  }
  const dated = render({ ...memory, valid_until: '2026-05-31',
    durability: 'temporary', confirmed_at: '2026-10-20T00:00:00Z' });
  assert.ok(dated.context.includes('- [fact, 2026-10-05, until 2026-05-31] A temporary fact.'));
  assert.deepEqual(dated.presentation, baseline.presentation, 'Validity metadata does not change the partial flag.');
  assert.deepEqual(dated.keys, baseline.keys);
  assert.doesNotMatch(dated.context, /durability|confirmed_at|2026-10-20/);
  assert.ok(render({ content: 'A fact.', valid_until: '2026-05-31' }).context.includes('- [until 2026-05-31] A fact.'));
  assert.deepEqual(render({ ...memory, durability: 'temporary', confirmed_at: '2026-10-20' }), baseline);
});

test('valid_until label bytes count toward the unchanged whole-memory recall budget', () => {
  const render = item => referenceContext({ items: [item] }, 10, [], () => {});
  const memory = { memory_type: 'fact', content: 'x' };
  const overhead = Buffer.byteLength(render(memory).context) - 1;
  memory.content = 'x'.repeat(HOOK_LIMITS.contextBytes - overhead);
  assert.equal(Buffer.byteLength(render(memory).context), HOOK_LIMITS.contextBytes);
  const dated = render({ ...memory, valid_until: '2026-05-31' });
  assert.equal(dated.context, '');
  assert.deepEqual(dated.presentation, [{ rank: 1, supplied: false, omit_reason: 'budget' }]);
});
