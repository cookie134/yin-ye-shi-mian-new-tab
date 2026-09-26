const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class FakeElement {
  constructor() {
    const classes = new Set();
    this.classList = {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const active = force ?? !classes.has(name);
        if (active) classes.add(name); else classes.delete(name);
        return active;
      }
    };
    this.inert = false;
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.isContentEditable = false;
    this.isConnected = true;
    this.tagName = 'BUTTON';
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.handlers = {};
    this.children = [];
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  emit(name, event = {}) { for (const handler of this.handlers[name] || []) handler(event); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  querySelector() { return null; }
  closest() { return null; }
  focus() { document.activeElement = this; }
  requestSubmit() { this.submissions = (this.submissions || 0) + 1; }
}
const nodes = {};
const documentHandlers = {};
const windowHandlers = {};
const timers = new Map();
let nextTimerId = 1;
const document = {
  body: new FakeElement(),
  activeElement: new FakeElement(),
  hidden: false,
  getElementById(id) { return nodes[id] ||= new FakeElement(); },
  createElement() { return new FakeElement(); },
  addEventListener(name, handler) { documentHandlers[name] = handler; }
};
const window = {
  addEventListener(name, handler) { windowHandlers[name] = handler; },
  setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  matchMedia() { return { matches: false }; },
  requestAnimationFrame(callback) { callback(); }
};
const local = new Map();
const localStorage = {
  getItem(key) { return local.has(key) ? local.get(key) : null; },
  setItem(key, value) { local.set(key, value); }
};
const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8').replace('void boot();', '');
const context = { document, window, localStorage, HTMLElement: FakeElement, crypto: require('node:crypto').webcrypto, structuredClone, console, Date, Intl, URL, URLSearchParams, AbortSignal };
vm.createContext(context);
vm.runInContext(source + ';globalThis.test={setupQuietMode,enterQuietMode,wakePage,advanceSnippetForVisit,ensureDailyFact,consumePreparedSnippet,normalizeIdleTimeout,dateKey,bindEvents,normalizeChatThreads,askAiForChat,getCuratedSnippets:()=>curatedSnippets,getState:()=>state,resetSnippetActivation:()=>{lastSnippetActivationAt=0},resetSnippetForVisit:()=>{generatedSnippetThisVisit=null;generatedSnippetApiKey=""},setSnippetIndex:(index)=>{activeSnippetIndex=index;renderDailyFact()},setGeneratedSnippetForVisit:(snippet,key)=>{generatedSnippetThisVisit=snippet;generatedSnippetApiKey=key}};', context);
(async () => {
  context.test.setupQuietMode();
  assert.equal([...timers.values()].at(-1).delay, 30000);
  const [firstTimerId, firstTimer] = [...timers.entries()][0];
  timers.delete(firstTimerId);
  firstTimer.callback();
  assert.equal(document.body.classList.contains('quiet-mode'), true);
  assert.equal(nodes.app.inert, true);
  let consumed = false;
  documentHandlers.keydown({ ctrlKey: false, metaKey: false, altKey: false, preventDefault() { consumed = true; }, stopImmediatePropagation() {} });
  assert.equal(consumed, true);
  assert.equal(document.body.classList.contains('quiet-mode'), false);
  assert.equal(nodes.app.inert, false);
  assert.equal(context.test.normalizeIdleTimeout(75), 75);
  assert.equal(context.test.normalizeIdleTimeout(0), 0);
  assert.equal(context.test.normalizeIdleTimeout(-1), 5);
  context.test.getState().settings.idleTimeoutSeconds = 0;
  context.test.wakePage();
  assert.equal(timers.size, 0);

  const sourced = context.test.getCuratedSnippets();
  assert.equal(sourced.length, 6);
  for (const snippet of sourced) {
    assert.ok(snippet.kind === 'quote' || snippet.kind === 'fact');
    assert.ok(snippet.attribution);
    assert.match(snippet.sourceUrl, /^https:\/\//);
  }
  await context.test.advanceSnippetForVisit();
  const first = nodes.dailyFactText.textContent;
  await context.test.advanceSnippetForVisit();
  assert.notEqual(nodes.dailyFactText.textContent, first);
  context.test.getState().settings.apiKey = 'test-only';
  context.test.getState().dailyFact = { dateKey: context.test.dateKey(new Date()), content: '这是一条没有来源的旧短句。', kind: 'inspiration' };
  await context.test.advanceSnippetForVisit();
  assert.doesNotMatch(nodes.dailyFactText.textContent, /没有来源/);
  assert.match(nodes.dailyFactText.textContent, /王维|杜甫|苏轼|NASA|NOAA|Smithsonian/);
  const prepared = {
    kind: 'fact', content: '月球总以近乎同一面朝向地球，因为自转与公转周期相同。',
    attribution: '维基百科《月球》', sourceUrl: 'https://zh.wikipedia.org/wiki/月球'
  };
  const nextPrepared = {
    kind: 'fact', content: '北极星靠近北天极，从北半球看位置显得相对稳定。',
    attribution: '维基百科《北极星》', sourceUrl: 'https://zh.wikipedia.org/wiki/北极星'
  };
  let queued = null;
  const messages = [];
  context.chrome = {
    storage: { local: { async get() { return {}; }, async set() {} } },
    runtime: { async sendMessage(message) {
      messages.push(message.type);
      if (message.type === 'snippet.warm') queued = prepared;
      if (message.type === 'snippet.consume') {
        const snippet = queued;
        queued = null;
        return { snippet };
      }
      return { ready: true };
    } }
  };
  await context.test.ensureDailyFact();
  assert.deepEqual(messages, ['snippet.warm', 'snippet.consume']);
  assert.equal(context.test.getState().dailyFact.kind, 'generated');
  assert.match(nodes.dailyFactText.textContent, /月球/);
  assert.match(nodes.dailyFactText.textContent, /维基百科/);
  context.test.resetSnippetForVisit();
  queued = nextPrepared;
  messages.length = 0;
  assert.equal(await context.test.consumePreparedSnippet(), true);
  context.test.setSnippetIndex(0);
  assert.deepEqual(messages, ['snippet.consume']);
  assert.match(nodes.dailyFactText.textContent, /北极星/);
  context.test.getState().settings.apiKey = '';
  context.chrome = undefined;
  await context.test.advanceSnippetForVisit();
  assert.match(nodes.dailyFactText.textContent, /王维|杜甫|苏轼|NASA|NOAA|Smithsonian/);
  context.test.setSnippetIndex(0);
  context.test.bindEvents();
  const threadCount = context.test.getState().chatThreads.length;
  nodes.dailyFactText.emit('click', { detail: 1 });
  assert.equal(context.test.getState().chatThreads.length, threadCount);
  nodes.dailyFactText.emit('dblclick');
  const quoteThread = context.test.getState().chatThreads.find((thread) => thread.id === context.test.getState().activeChatId);
  assert.equal(document.body.classList.contains('assistant-open'), true);
  assert.match(quoteThread.messages[0].content, /这句是我从/);
  assert.match(quoteThread.messages[0].content, /你对它感兴趣吗/);
  assert.match(quoteThread.messages[0].content, /接入 API/);
  assert.equal(quoteThread.homeSnippet.kind, 'quote');
  assert.match(quoteThread.messages[0].sourceUrl, /wikisource/);
  assert.equal(nodes.chatLog.children[0].children[1].textContent, '查看出处 ↗');
  context.test.getState().settings.apiKey = 'test-only';
  context.test.setGeneratedSnippetForVisit(sourced[0], 'test-only');
  context.test.resetSnippetActivation();
  nodes.dailyFactText.emit('dblclick');
  const connectedThread = context.test.getState().chatThreads.find((thread) => thread.id === context.test.getState().activeChatId);
  assert.match(connectedThread.messages[0].content, /想聊聊它的来处/);
  assert.notEqual(connectedThread.id, quoteThread.id);
  context.test.resetSnippetActivation();
  let prevented = false;
  nodes.dailyFactText.emit('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(context.test.getState().chatThreads.length, threadCount + 3);

  nodes.chatInput.value = '它的背景是什么？';
  let enterPrevented = false;
  nodes.chatInput.emit('keydown', { key: 'Enter', keyCode: 13, shiftKey: false, isComposing: false, preventDefault() { enterPrevented = true; } });
  assert.equal(enterPrevented, true);
  assert.equal(nodes.chatForm.submissions, 1);
  nodes.chatInput.emit('keydown', { key: 'Enter', keyCode: 13, shiftKey: true, isComposing: false, preventDefault() { throw new Error('Shift+Enter must insert a newline'); } });
  nodes.chatInput.emit('keydown', { key: 'Enter', keyCode: 229, shiftKey: false, isComposing: true, preventDefault() { throw new Error('IME Enter must not send'); } });
  assert.equal(nodes.chatForm.submissions, 1);
  nodes.chatInput.value = '   ';
  nodes.chatInput.emit('keydown', { key: 'Enter', keyCode: 13, shiftKey: false, isComposing: false, preventDefault() {} });
  assert.equal(nodes.chatForm.submissions, 1);

  const legacyThread = context.test.normalizeChatThreads([{ id: 'old-snippet', title: '以前的对话', messages: [{
    id: 'old-opener', role: 'assistant', content: '我看到你停在了“把复杂的事物退远一点，轮廓会先说话。”。你对它感兴趣吗？想聊聊它的背景，还是它让你想到的事？', createdAt: 1
  }], createdAt: 1, updatedAt: 1 }], [])[0];
  assert.equal(legacyThread.homeSnippet.kind, 'reflection');
  assert.equal(legacyThread.homeSnippet.content, '把复杂的事物退远一点，轮廓会先说话。');
  vm.runInContext('chatCompletion = async (system, user) => { globalThis.aiCall = { system, user }; return JSON.stringify({ reply: "这是我为首页写的短句。", notes: [] }); };', context);
  await context.test.askAiForChat('它的背景是什么？', legacyThread);
  assert.equal(JSON.parse(context.aiCall.user).homeSnippet.kind, 'reflection');
  assert.match(context.aiCall.system, /your own short homepage line/);

  nodes.closeAssistantButton.emit('click');
  nodes.timeSettingsButton.focus();
  let shortcutPrevented = false;
  const summon = () => documentHandlers.keydown({
    key: 's', code: 'KeyS', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
    preventDefault() { shortcutPrevented = true; }
  });
  summon();
  assert.equal(shortcutPrevented, true);
  assert.equal(document.body.classList.contains('assistant-open'), true);
  assert.equal(document.activeElement, nodes.chatInput);
  nodes.closeAssistantButton.emit('click');
  assert.equal(document.activeElement, nodes.timeSettingsButton);

  nodes.searchInput.tagName = 'INPUT';
  nodes.searchInput.focus();
  shortcutPrevented = false;
  summon();
  assert.equal(shortcutPrevented, false);
  assert.equal(document.body.classList.contains('assistant-open'), false);

  nodes.timeSettingsButton.focus();
  document.body.classList.add('quiet-mode');
  nodes.app.inert = true;
  summon();
  assert.equal(document.body.classList.contains('quiet-mode'), false);
  assert.equal(nodes.app.inert, false);
  assert.equal(document.body.classList.contains('assistant-open'), true);
  nodes.closeAssistantButton.focus();
  summon();
  assert.equal(document.activeElement, nodes.chatInput);
  documentHandlers.keydown({ key: 'Escape' });
  assert.equal(document.body.classList.contains('assistant-open'), false);
  assert.equal(document.activeElement, nodes.timeSettingsButton);

  nodes.assistantToggleButton.focus();
  nodes.assistantToggleButton.emit('click');
  assert.equal(document.body.classList.contains('assistant-open'), true);
  nodes.closeAssistantButton.emit('click');
  assert.equal(document.activeElement, nodes.assistantToggleButton);
  console.log('home smoke passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
