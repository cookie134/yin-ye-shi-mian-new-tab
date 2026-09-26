const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8').replace('void boot();', '');
const document = { getElementById() { return {}; } };
const saved = [];
const context = {
  document, URL, structuredClone, Date,
  crypto: require('node:crypto').webcrypto,
  localStorage: { setItem(key, value) { saved.push([key, value]); } }
};
vm.createContext(context);
vm.runInContext(source + `
  renderShortcuts = () => {};
  const switches = [];
  showGalleryBackground = (id, effect) => { switches.push([id, effect]); };
  restartSlideshow = () => {};
  globalThis.test = {
    moveShortcutOutOfFolder, normalizeBackgroundMode, normalizeSlideshowSeconds,
    normalizeBackgroundGallery, changeGalleryBackground, switches,
    getState: () => state, getCurrentBackgroundId: () => currentBackgroundId,
    setCurrentBackgroundId: (id) => { currentBackgroundId = id; }
  };
`, context);

(async () => {
  const state = context.test.getState();
  state.shortcutFolders = [{ id: 'f', title: '收藏文件夹' }];
  state.shortcuts = [
    { id: 'one', title: 'A', url: 'https://a.example', folderId: 'f' },
    { id: 'two', title: 'B', url: 'https://b.example', folderId: 'f' }
  ];
  context.test.moveShortcutOutOfFolder('one');
  assert.equal(state.shortcuts[0].folderId, undefined);
  assert.equal(state.shortcuts[1].folderId, 'f');
  assert.equal(state.shortcutFolders.length, 1);
  context.test.moveShortcutOutOfFolder('two');
  assert.equal(state.shortcutFolders.length, 0);
  await new Promise(setImmediate);
  assert.ok(saved.length > 0);

  assert.equal(context.test.normalizeBackgroundMode(undefined, 'https://old.example/image.gif'), 'url');
  assert.equal(context.test.normalizeBackgroundMode(undefined, ''), 'bing');
  assert.equal(context.test.normalizeBackgroundMode(undefined, '', '#123456'), 'color');
  assert.equal(context.test.normalizeSlideshowSeconds(-2), 0);
  assert.equal(context.test.normalizeSlideshowSeconds(5000), 3600);
  const gallery = context.test.normalizeBackgroundGallery([
    { id: 'safe', title: 'image', source: 'url', url: 'https://example.com/image.gif' },
    { id: 'unsafe', title: 'image', source: 'url', url: 'javascript:alert(1)' }
  ]);
  assert.equal(gallery.length, 1);
  assert.equal(gallery[0].id, 'safe');

  state.settings.backgroundMode = 'gallery';
  state.settings.shuffleBackgrounds = false;
  state.backgroundGallery = [
    { id: 'a', title: 'A', source: 'url', url: 'https://example.com/a.png' },
    { id: 'b', title: 'B', source: 'url', url: 'https://example.com/b.png' },
    { id: 'c', title: 'C', source: 'url', url: 'https://example.com/c.png' }
  ];
  context.test.setCurrentBackgroundId('a');
  context.test.changeGalleryBackground(1, 'fade');
  assert.equal(context.test.getCurrentBackgroundId(), 'b');
  context.test.changeGalleryBackground(-1, 'zoom');
  assert.equal(context.test.getCurrentBackgroundId(), 'a');
  assert.deepEqual(Array.from(context.test.switches, pair => Array.from(pair)), [['b', 'fade'], ['a', 'zoom']]);
  console.log('background and folders passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
