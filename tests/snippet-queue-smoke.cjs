const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const values = new Map();
values.set('edgeAiNewTabState', {
  settings: {
    provider: 'deepseek', baseUrl: 'https://api.example.test', model: 'test-model', apiKey: 'test-only'
  }
});
globalThis.chrome = {
  storage: { local: {
    async get(key) { return { [key]: values.get(key) }; },
    async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); }
  } }
};

const pages = Array.from({ length: 24 }, (_, index) => ({
  pageid: index + 1,
  title: `主题${index + 1}`,
  extract: `主题${index + 1}的来源资料详细说明了一项有趣的自然现象，并给出可以核对的具体背景。`.repeat(4),
  fullurl: `https://zh.wikipedia.org/wiki/主题${index + 1}`
}));
let modelCalls = 0;
let failAfter = 3;
let networkOffline = false;
globalThis.fetch = async (url, options = {}) => {
  if (networkOffline) throw new Error('offline test');
  if (url.startsWith('https://zh.wikipedia.org/')) {
    return { ok: true, json: async () => ({ query: { pages } }) };
  }
  assert.equal(url, 'https://api.example.test/chat/completions');
  assert.equal(options.headers.Authorization, 'Bearer test-only');
  modelCalls++;
  const input = JSON.parse(JSON.parse(options.body).messages[1].content);
  const count = modelCalls === 1 ? Math.min(3, input.count) : input.count;
  const items = input.articles.slice(0, count).map((article) => ({
    id: article.id,
    content: `关于${article.title}的一条全新冷知识，来源资料清楚地说明了它。`,
    evidence: failAfter === 3 && modelCalls > 1 ? '来源里找不到的文字' : article.extract.slice(0, 24)
  }));
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }] })
  };
};

(async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'snippet-queue.js')).href;
  const { consumeSnippet, fillSnippetQueue } = await import(moduleUrl);
  assert.equal(await consumeSnippet(), null);
  await fillSnippetQueue();
  let queue = values.get('edgeAiNewTabPreparedSnippets');
  assert.equal(queue.items.length, 3);
  assert.equal(queue.ready, false);
  assert.equal(await consumeSnippet(), null, 'an incomplete first batch must not be shown');

  failAfter = Infinity;
  await fillSnippetQueue();
  queue = values.get('edgeAiNewTabPreparedSnippets');
  assert.equal(queue.items.length, 10);
  assert.equal(queue.ready, true);
  assert.equal(modelCalls, 3, 'valid results should fill the remaining queue in one batch');
  assert.equal(new Set(queue.items.map((item) => item.sourceUrl)).size, 10);
  const first = await consumeSnippet();
  assert.match(first.content, /主题1/);
  queue = values.get('edgeAiNewTabPreparedSnippets');
  assert.equal(queue.items.length, 9);
  await fillSnippetQueue();
  queue = values.get('edgeAiNewTabPreparedSnippets');
  assert.equal(queue.items.length, 10);
  assert.equal(new Set(queue.items.map((item) => item.sourceUrl)).size, 10);
  assert.ok(queue.recentUrls.includes(first.sourceUrl));

  const seen = new Set([first.sourceUrl]);
  for (let index = 0; index < 10; index++) {
    const snippet = await consumeSnippet();
    assert.ok(snippet);
    assert.equal(seen.has(snippet.sourceUrl), false);
    seen.add(snippet.sourceUrl);
  }
  assert.equal(await consumeSnippet(), null);
  await fillSnippetQueue();
  let messageHandler;
  Object.assign(globalThis.chrome, {
    runtime: {
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener(handler) { messageHandler = handler; } }
    },
    alarms: { onAlarm: { addListener() {} } },
    contextMenus: { onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} } }
  });
  await import(pathToFileURL(path.join(__dirname, '..', 'background.js')).href);
  networkOffline = true;
  const response = await new Promise((resolve) => {
    assert.equal(messageHandler({ type: 'snippet.consume' }, {}, resolve), true);
  });
  assert.ok(response.snippet, 'the real worker entry point must serve prepared snippets');
  await fillSnippetQueue();
  assert.equal(values.get('edgeAiNewTabPreparedSnippets').items.length, 9,
    'cached display must succeed while source and AI requests are offline');
  networkOffline = false;
  await fillSnippetQueue();
  assert.equal(values.get('edgeAiNewTabPreparedSnippets').items.length, 10);
  values.get('edgeAiNewTabState').settings.apiKey = 'different-key';
  assert.equal(await consumeSnippet(), null, 'a changed API profile must not reuse the old queue');
  console.log('snippet queue passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
