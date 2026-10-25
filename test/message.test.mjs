import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TYPES, lintMessage, parseMessage } from '../dist/message.js';
import { validateConfig } from '../dist/config.js';

for (const type of DEFAULT_TYPES) {
  test(`default type ${type} supports case-insensitive matching`, () => {
    assert.deepEqual(lintMessage(`${type.toUpperCase()}(API): Keep Unicode café 日本語`).diagnostics, []);
  });
}

for (const message of [
  'feat: add a feature', 'fix(scope)!: Change API', 'feat!: Remove the old API',
  'docs(日本語): 更新する', `feat: ${'long '.repeat(80)}`,
  'fix: patch\r\n\r\nBody café\r\nmore context\r\n\r\nRefs: #12\r\n',
  'chore: update\n\nBREAKING CHANGE: Move settings\nUse the new path\nRefs: #12',
  'build: update\n\nBREAKING-CHANGE: New runtime\nReviewed-by: A',
]) {
  test(`valid message ${JSON.stringify(message).slice(0, 95)}`, () => {
    assert.deepEqual(lintMessage(message).diagnostics, []);
  });
}

for (const message of [
  '', '   ', ': missing type', 'feat:', 'feat: ', 'feat:    ', 'feat:no space',
  'feat : description', 'feat(): empty scope', 'feat( ): blank scope',
  'feat(scope: broken', 'feat(scope)!!: double marker', '\nfeat: leading newline',
  'feat: header\nbody without separation',
  'feat: header\n\nBREAKING CHANGE:no space',
  'feat: header\n\nBREAKING CHANGE: ',
  'feat: header\n\nbreaking change: wrong case',
  'feat: header\n\nbreaking-change: wrong case',
  'feat: header\n\nBREAKING CHANGE #123',
  'feat: header\n\nbody\nBREAKING CHANGE: missing separator',
  'feat: header\n\nReviewed-by: ', 'feat: null\0', 'feat: bare\rreturn',
]) {
  test(`reject ${JSON.stringify(message)}`, () => {
    assert.ok(lintMessage(message).diagnostics.length > 0);
  });
}

test('preserves multiple body paragraphs, literal content, and multiline footer values', () => {
  const message = 'feat(界面): Add controls\n\nFirst paragraph\ngpg: literal body text\n\n---\nSecond paragraph\n\nReviewed-by: Zoë\nsecond reviewer\n\nmore detail\nRefs #123\nReviewed-by: 李\nBREAKING-CHANGE: Remove old controls\nMigration instructions';
  const result = parseMessage(message);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.parsed.body, 'First paragraph\ngpg: literal body text\n\n---\nSecond paragraph');
  assert.deepEqual(result.parsed.footers.map(({ token, separator, value }) => ({ token, separator, value })), [
    { token: 'Reviewed-by', separator: ': ', value: 'Zoë\nsecond reviewer\n\nmore detail' },
    { token: 'Refs', separator: ' #', value: '123' },
    { token: 'Reviewed-by', separator: ': ', value: '李' },
    { token: 'BREAKING-CHANGE', separator: ': ', value: 'Remove old controls\nMigration instructions' },
  ]);
  assert.deepEqual(result.parsed.breakingDescriptions, ['Remove old controls\nMigration instructions']);
});

test('each valid footer token terminates the prior breaking value', () => {
  const result = parseMessage('fix!: Update\n\nBREAKING CHANGE: First\nline\nReviewed-by: A\nBREAKING-CHANGE: Second\nRefs: #3');
  assert.deepEqual(result.parsed.breakingDescriptions, ['First\nline', 'Second']);
  assert.equal(result.parsed.footers.length, 4);
});

test('bang alone uses the description as breaking information', () => {
  assert.deepEqual(parseMessage('fix!: Drop old behavior').parsed.breakingDescriptions, ['Drop old behavior']);
});

test('Unicode type and footer tokens, scope punctuation, and continuation whitespace survive', () => {
  const result = lintMessage('修正(core/ui.v2): Correct behavior\n\n確認者: 李\n  notes\nRefs: #1', ['修正']);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.parsed.scope, 'core/ui.v2');
  assert.equal(result.parsed.footers[0].value, '李\n  notes');
});

test('type policy is independent of historical message structure', () => {
  const message = 'custom: Update\n\nBREAKING CHANGE: Requires migration';
  assert.deepEqual(parseMessage(message).diagnostics, []);
  assert.equal(parseMessage(message).parsed.breaking, true);
  assert.equal(lintMessage(message).diagnostics[0].rule, 'type-allowed');
  assert.deepEqual(lintMessage(message, ['CUSTOM']).diagnostics, []);
});

test('free-form bodies may contain indented tokens or non-separated token-like text', () => {
  const result = parseMessage('docs: Example\n\nAn example follows:\nRefs: literal body\n  Key: still body');
  assert.equal(result.parsed.footers.length, 0);
  assert.equal(result.parsed.body, 'An example follows:\nRefs: literal body\n  Key: still body');
});

test('configuration extends or replaces defaults, then adds extensions', () => {
  assert.ok(validateConfig({ extendTypes: ['release', 'RELEASE'] }).includes('feat'));
  assert.equal(validateConfig({ extendTypes: ['release', 'RELEASE'] }).filter(x => x === 'release').length, 1);
  assert.deepEqual(validateConfig({ allowedTypes: ['CUSTOM'], extendTypes: ['修正'] }), ['custom', '修正']);
});

for (const config of [null, [], true, 'feat', { typo: [] }, { allowedTypes: [] },
  { allowedTypes: 'feat' }, { extendTypes: [null] }, { extendTypes: ['bad type'] },
  { allowedTypes: [''] }, { allowedTypes: [3] }, { extendTypes: null }]) {
  test(`reject config ${JSON.stringify(config)}`, () => assert.throws(() => validateConfig(config)));
}
