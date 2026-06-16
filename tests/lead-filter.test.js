const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadLeadFilter() {
  const context = {};
  context.window = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'lead-filter.js'), 'utf8'),
    context,
  );
  return context.DaoEduLeadFilter;
}

function item(overrides) {
  return {
    kind: 'COMMENT',
    authorName: 'User',
    authorUrl: '',
    text: '',
    pageUrl: 'https://www.facebook.com/groups/test/posts/1/',
    sourceUrl: 'https://www.facebook.com/groups/test/posts/1/',
    depth: 1,
    contextTexts: [],
    capturedAt: new Date().toISOString(),
    fingerprint: Math.random().toString(36),
    ...overrides,
  };
}

test('detects direct parent demand at comment level', () => {
  const analysis = loadLeadFilter().analyze([
    item({
      authorName: 'Phu huynh A',
      text: 'Can tim lop tieng anh cho con lop 7',
      depth: 1,
      contextTexts: ['Can tim lop tieng anh cho con lop 7'],
    }),
  ]);

  const profile = analysis.profiles[0];
  assert.equal(profile.classification, 'POTENTIAL_PARENT');
  assert.equal(profile.metrics.bestEvidenceLevel, 'COMMENT');
  assert.notEqual(profile.leadLevel, 'NONE');
});

test('uses parent education context for reply intent', () => {
  const analysis = loadLeadFilter().analyze([
    item({
      authorName: 'Phu huynh B',
      text: 'Cho minh xin hoc phi voi a',
      depth: 2,
      contextTexts: [
        'Tim lop tieng anh cho con lop 7',
        'Cho minh xin hoc phi voi a',
      ],
    }),
  ]);

  const profile = analysis.profiles[0];
  assert.equal(profile.classification, 'POTENTIAL_PARENT');
  assert.equal(profile.metrics.bestEvidenceLevel, 'REPLY');
});

test('does not inherit parent demand for teacher ads', () => {
  const analysis = loadLeadFilter().analyze([
    item({
      authorName: 'Co giao C',
      text: 'Mom tham khao lop co Thi Thao Cao, co nhom nho va khai giang tuan nay',
      depth: 2,
      contextTexts: [
        'Tim lop tieng anh cho con lop 7',
        'Mom tham khao lop co Thi Thao Cao, co nhom nho va khai giang tuan nay',
      ],
    }),
  ]);

  const profile = analysis.profiles[0];
  assert.equal(profile.classification, 'TEACHER_AD');
  assert.equal(profile.leadLevel, 'NONE');
});

test('keeps marker comments neutral even under education context', () => {
  const analysis = loadLeadFilter().analyze([
    item({
      authorName: 'User D',
      text: 'Cham',
      depth: 2,
      contextTexts: ['Tim lop tieng anh cho con lop 7', 'Cham'],
    }),
  ]);

  const profile = analysis.profiles[0];
  assert.equal(profile.classification, 'NEUTRAL');
});
