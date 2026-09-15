const test = require('node:test');
const assert = require('node:assert/strict');
const Library = require('../web/workflow-library.js');

const listing = [
  { path: 'About Mie.json', size: 626, modified: 1000 },
  { path: '全部/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json', size: 110234, modified: 2000 },
  { path: '开箱即用/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json', size: 110234, modified: 2000 },
  { path: 'notes.txt', size: 12, modified: 1 },
  { path: '../escape.json', size: 12, modified: 1 },
  { path: '/absolute.json', size: 12, modified: 1 },
  { path: 'windows\\style.json', size: 12, modified: 1 },
  { path: 'dup.json', size: 3, modified: 5 },
  { path: 'dup.json', size: 3, modified: 9 },
  { path: 42, size: 1 },
  null,
];

test('清单整理：只留合法工作流文件，去重，按目录+名字排序', () => {
  const entries = Library.normalizeEntries(listing);
  assert.deepEqual(entries.map((entry) => entry.path), [
    'About Mie.json',
    'dup.json',
    '全部/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json',
    '开箱即用/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json',
  ]);
  assert.equal(entries[0].name, 'About Mie');
  assert.equal(entries[0].folder, '');
  assert.equal(entries[2].folder, '全部/图像/图像生成/Krea-2');
  assert.equal(entries[2].name, 'moodyKrea24KHD_v20');
  assert.equal(entries[2].size, 110234);
});

test('清单整理：非数组、脏字段、超长名字都被兜住', () => {
  assert.deepEqual(Library.normalizeEntries(null), []);
  assert.deepEqual(Library.normalizeEntries('nope'), []);
  const long = 'x'.repeat(400);
  const entries = Library.normalizeEntries([{ path: `全部/${long}.json` }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name.length, 120);
  const cleaned = Library.normalizeEntries([{ path: 'a\u0000b.json' }]);
  assert.equal(cleaned[0].path, 'ab.json');
  assert.equal(cleaned[0].size, 0);
  assert.equal(cleaned[0].modified, 0);
});

test('source 和电脑端标签页的 path 格式一致', () => {
  const entries = Library.normalizeEntries(listing);
  assert.equal(Library.sourceOf(entries[0]), 'workflows/About Mie.json');
  assert.equal(
    Library.sourceOf(entries[2]),
    'workflows/全部/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json',
  );
  assert.equal(Library.sourceOf(null), '');
});

test('搜索：名字和目录都能命中，忽略大小写，空词返回全部', () => {
  const entries = Library.normalizeEntries(listing);
  assert.equal(Library.filterEntries(entries, '').length, entries.length);
  assert.deepEqual(Library.filterEntries(entries, 'krea').map((e) => e.name), [
    'moodyKrea24KHD_v20', 'moodyKrea24KHD_v20',
  ]);
  assert.deepEqual(Library.filterEntries(entries, 'MOODY').length, 2);
  assert.deepEqual(Library.filterEntries(entries, '开箱即用').length, 1);
  assert.deepEqual(Library.filterEntries(entries, '不存在的名字'), []);
});

test('记录匹配：靠 source 对上号，标出已导入和常驻', () => {
  const entries = Library.normalizeEntries(listing);
  const described = Library.describe(entries, [
    { id: 'rec-pinned', name: 'moody', source: 'workflows/开箱即用/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json', pinned: true },
    { id: 'rec-open', name: 'About Mie', source: 'workflows/About Mie.json', pinned: false },
    null,
  ]);
  const byPath = Object.fromEntries(described.map((item) => [item.path, item]));
  assert.equal(byPath['About Mie.json'].imported, true);
  assert.equal(byPath['About Mie.json'].pinned, false);
  assert.equal(byPath['About Mie.json'].recordId, 'rec-open');
  assert.equal(byPath['开箱即用/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json'].pinned, true);
  assert.equal(byPath['全部/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json'].imported, false);
  assert.equal(byPath['dup.json'].recordId, '');
  assert.deepEqual(Library.summarize(described), { total: 4, imported: 2, pinned: 1 });
});

test('记录匹配：磁盘上的路径变了，还能靠 library_path 认出来', () => {
  const entries = Library.normalizeEntries([{ path: '全部/新目录/小马.json' }]);
  const described = Library.describe(entries, [
    { id: 'rec-1', name: '小马', source: 'workflows/全部/老目录/小马.json', pinned: true, library_path: '全部/新目录/小马.json' },
  ]);
  assert.equal(described[0].imported, true);
  assert.equal(described[0].pinned, true);
  assert.equal(described[0].recordId, 'rec-1');
});
