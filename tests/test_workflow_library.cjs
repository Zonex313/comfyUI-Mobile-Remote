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

const treeListing = [
  { path: 'About Mie.json', size: 626 },
  { path: 'moodyKrea24KHD_v20.json', size: 110234 },
  { path: '全部/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json', size: 1 },
  { path: '全部/图像/图像生成/Anima/Anima_Base.json', size: 2 },
  { path: '全部/图像/图像生成/Anima/Anima_Turbo.json', size: 3 },
  { path: '全部/图像/图像编辑/Krea-2/edit.json', size: 4 },
  { path: '全部/视频/Wan2.1/Wan2.1_T2V.json', size: 5 },
  { path: '开箱即用/图像/图像生成/Krea-2/moodyKrea24KHD_v20.json', size: 6 },
];

const shape = (node) => ({
  name: node.name,
  path: node.path,
  count: node.count,
  files: node.files.map((entry) => entry.name),
  folders: node.folders.map(shape),
});

test('目录树：层级和磁盘结构一致，每层按名字排序，count 是递归总数', () => {
  const tree = Library.buildTree(Library.normalizeEntries(treeListing));
  assert.deepEqual(tree.files.map((entry) => entry.name), ['About Mie', 'moodyKrea24KHD_v20']);
  assert.deepEqual(tree.folders.map(shape), [
    {
      name: '全部', path: '全部', count: 5, files: [], folders: [
        {
          name: '图像', path: '全部/图像', count: 4, files: [], folders: [
            {
              name: '图像生成', path: '全部/图像/图像生成', count: 3, files: [], folders: [
                { name: 'Anima', path: '全部/图像/图像生成/Anima', count: 2, files: ['Anima_Base', 'Anima_Turbo'], folders: [] },
                { name: 'Krea-2', path: '全部/图像/图像生成/Krea-2', count: 1, files: ['moodyKrea24KHD_v20'], folders: [] },
              ],
            },
            {
              name: '图像编辑', path: '全部/图像/图像编辑', count: 1, files: [], folders: [
                { name: 'Krea-2', path: '全部/图像/图像编辑/Krea-2', count: 1, files: ['edit'], folders: [] },
              ],
            },
          ],
        },
        {
          name: '视频', path: '全部/视频', count: 1, files: [], folders: [
            { name: 'Wan2.1', path: '全部/视频/Wan2.1', count: 1, files: ['Wan2.1_T2V'], folders: [] },
          ],
        },
      ],
    },
    {
      name: '开箱即用', path: '开箱即用', count: 1, files: [], folders: [
        {
          name: '图像', path: '开箱即用/图像', count: 1, files: [], folders: [
            {
              name: '图像生成', path: '开箱即用/图像/图像生成', count: 1, files: [], folders: [
                { name: 'Krea-2', path: '开箱即用/图像/图像生成/Krea-2', count: 1, files: ['moodyKrea24KHD_v20'], folders: [] },
              ],
            },
          ],
        },
      ],
    },
  ]);
  // 内部索引不该泄漏出去
  assert.equal('children' in tree.folders[0], false);
});

test('目录树：空输入、脏输入都返回空树', () => {
  for (const value of [null, undefined, 'nope', [], [null, 7, {}]]) {
    assert.deepEqual(Library.buildTree(value), { files: [], folders: [] });
  }
});

test('目录树：folderPaths 给出去重的全部目录路径（展开全部用）', () => {
  const tree = Library.buildTree(Library.normalizeEntries(treeListing));
  assert.deepEqual(Library.folderPaths(tree), [
    '全部',
    '全部/图像',
    '全部/图像/图像生成',
    '全部/图像/图像生成/Anima',
    '全部/图像/图像生成/Krea-2',
    '全部/图像/图像编辑',
    '全部/图像/图像编辑/Krea-2',
    '全部/视频',
    '全部/视频/Wan2.1',
    '开箱即用',
    '开箱即用/图像',
    '开箱即用/图像/图像生成',
    '开箱即用/图像/图像生成/Krea-2',
  ]);
  assert.deepEqual(Library.folderPaths(null), []);
});

test('目录树：搜索之后只剩命中的分支，但仍然保留层级', () => {
  const entries = Library.normalizeEntries(treeListing);
  const tree = Library.buildTree(Library.filterEntries(entries, 'anima'));
  assert.deepEqual(tree.folders.map(shape), [
    {
      name: '全部', path: '全部', count: 2, files: [], folders: [
        {
          name: '图像', path: '全部/图像', count: 2, files: [], folders: [
            {
              name: '图像生成', path: '全部/图像/图像生成', count: 2, files: [], folders: [
                { name: 'Anima', path: '全部/图像/图像生成/Anima', count: 2, files: ['Anima_Base', 'Anima_Turbo'], folders: [] },
              ],
            },
          ],
        },
      ],
    },
  ]);
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

/* 真实遇到过的一份工作流：节点 16 的 clip 输入写着连线 14、输出写着 15，
 * 连线表里却只有 18（7→16 的 clip）和 19（16→9 的条件）。画布转换提示词时
 * 拿节点上的号去查表，查不到就抛 “No link found in parent graph …”，
 * 一个残号让整份工作流导不进来。 */
test('连线修正：节点上的残号按连线表补回，画布转换不再报错', () => {
  const graph = {
    nodes: [
      { id: 7, inputs: [], outputs: [{ name: 'CLIP', links: [18] }] },
      { id: 16, inputs: [{ name: 'clip', link: 14 }, { name: 'text', link: null }], outputs: [{ name: 'CONDITIONING', links: [15] }] },
      { id: 9, inputs: [{ name: 'positive', link: 19 }, { name: 'negative', link: null }], outputs: [] },
    ],
    links: [[18, 7, 0, 16, 0, 'CLIP'], [19, 16, 0, 9, 1, 'CONDITIONING']],
  };
  assert.equal(Library.reconcileLinks(graph), 0, '两条都能从连线表补回来，没有丢连接');
  assert.equal(graph.nodes[1].inputs[0].link, 18);
  assert.deepEqual(graph.nodes[1].outputs[0].links, [19]);
  assert.equal(graph.nodes[2].inputs[0].link, 19);
});

test('连线修正：连线表里也没有的残号当作没接，并把条数报出来', () => {
  const graph = { nodes: [{ id: 1, inputs: [{ name: 'model', link: 5 }], outputs: [] }], links: [] };
  assert.equal(Library.reconcileLinks(graph), 1);
  assert.equal(graph.nodes[0].inputs[0].link, null);
});

test('连线修正：健康的工作流一个字节都不改', () => {
  const graph = {
    nodes: [
      { id: 1, inputs: [], outputs: [{ links: [3] }] },
      { id: 2, inputs: [{ name: 'model', link: 3 }], outputs: [] },
    ],
    links: [[3, 1, 0, 2, 0, 'MODEL']],
  };
  const before = JSON.stringify(graph);
  assert.equal(Library.reconcileLinks(graph), 0);
  assert.equal(JSON.stringify(graph), before);
});

test('连线修正：脏输入不炸', () => {
  assert.equal(Library.reconcileLinks(null), 0);
  assert.equal(Library.reconcileLinks(undefined), 0);
  assert.equal(Library.reconcileLinks({}), 0);
  assert.equal(Library.reconcileLinks({ nodes: 'x', links: 'y' }), 0);
  assert.equal(Library.reconcileLinks({ nodes: [null, 3], links: [null, 'x'] }), 0);
});
