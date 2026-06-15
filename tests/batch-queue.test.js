const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBatchQueue() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '..', 'batch-queue.js'),
      'utf8',
    ),
    context,
  );
  return context.DaoEduBatchQueue;
}

test('keeps discovery order across feed rounds', () => {
  const queue = loadBatchQueue().create(5);

  queue.append(['post-1', 'post-2']);
  queue.append(['post-2', 'post-3', 'post-4']);

  assert.deepEqual(Array.from(queue.values()), [
    'post-1',
    'post-2',
    'post-3',
    'post-4',
  ]);
});

test('excludes old URLs and stops at exactly ten posts', () => {
  const queue = loadBatchQueue().create(10, ['post-1', 'post-3']);
  const discovered = Array.from(
    { length: 15 },
    (_, index) => `post-${index + 1}`,
  );

  queue.append(discovered);

  assert.equal(queue.size, 10);
  assert.equal(queue.isFull(), true);
  assert.deepEqual(Array.from(queue.values()), [
    'post-2',
    'post-4',
    'post-5',
    'post-6',
    'post-7',
    'post-8',
    'post-9',
    'post-10',
    'post-11',
    'post-12',
  ]);
});
