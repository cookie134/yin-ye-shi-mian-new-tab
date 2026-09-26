const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor() { this.value = ''; this.textContent = ''; this.hidden = false; this.checked = false; this.options = []; }
  replaceChildren(...items) { this.options = items; this.value = items[0]?.value ?? ''; }
  focus() {}
}
const nodes = {};
const styleVars = {};
const document = {
  body: { style: { setProperty(name, value) { styleVars[name] = value; } } },
  getElementById(id) { return nodes[id] ||= new FakeElement(); },
  createElement() { return { click() {}, href: '', download: '' }; }
};
let exportedBlob;
class FakeUrl extends URL {
  static createObjectURL(blob) { exportedBlob = blob; return 'blob:test'; }
  static revokeObjectURL() {}
}
const calls = [];
const fetch = async (url, options) => {
  calls.push({ url, authorization: options.headers.Authorization });
  return { ok: true, json: async () => ({ data: [
    { id: 'gemini-3.8-flash' }, { id: 'gemini-embedding-001' }, { id: 'gemini-3.1-pro' }
  ] }) };
};
const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8').replace('void boot();', '');
const context = {
  document, fetch, URL: FakeUrl, Blob, Date, structuredClone, AbortController,
  crypto: require('node:crypto').webcrypto,
  Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  window: { setTimeout, clearTimeout }
};
vm.createContext(context);
vm.runInContext(source + `
  globalThis.test = {
    mergeState, renderSettings, handleProviderChange, refreshAvailableModels, handleExport,
    parseChatDecision, buildReminderNotificationMessage, prepareDailyReminderAside, isChatModel,
    buildConversationHistory, normalizeChatMessages, askAiForChat, executeChatPageAction, applyHomeTextStyle, createStickyNote, getState: () => state,
    setState: (value) => { state = value; }, addPendingImage: (id, file) => pendingChatImages.set(id, file)
  };
`, context);

(async () => {
  const legacy = context.test.mergeState({ settings: {
    provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'deep-key'
  } });
  assert.equal(legacy.settings.providerProfiles.deepseek.apiKey, 'deep-key');
  const visualSettings = context.test.mergeState({ settings: { ...legacy.settings, homeTextColor: '#203040', homeTextContrast: 'none' } });
  assert.equal(visualSettings.settings.homeTextColor, '#203040');
  assert.equal(visualSettings.settings.homeTextContrast, 'none');
  assert.equal(context.test.mergeState({ settings: { ...legacy.settings, homeTextColor: 'invalid' } }).settings.homeTextColor, '#ffffff');
  context.test.setState(legacy);
  context.test.renderSettings();
  nodes.providerSelect.value = 'gemini';
  context.test.handleProviderChange();
  assert.equal(nodes.baseUrlInput.value, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(nodes.apiKeyInput.value, '');
  nodes.apiKeyInput.value = 'gemini-key';
  await context.test.refreshAvailableModels();
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.equal(calls[0].authorization, 'Bearer gemini-key');
  assert.equal(nodes.modelSelect.options.some((option) => option.value === 'gemini-embedding-001'), false);
  assert.equal(nodes.modelSelect.options.some((option) => option.value === 'gemini-3.1-pro'), true);
  nodes.providerSelect.value = 'deepseek';
  context.test.handleProviderChange();
  assert.equal(nodes.apiKeyInput.value, 'deep-key');

  legacy.settings.providerProfiles.gemini = {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash', apiKey: 'gemini-key'
  };
  context.test.handleExport();
  const exported = JSON.parse(await exportedBlob.text());
  assert.equal(exported.settings.apiKey, '');
  assert.equal(exported.settings.providerProfiles.deepseek.apiKey, '');
  assert.equal(exported.settings.providerProfiles.gemini.apiKey, '');
  assert.equal(legacy.settings.providerProfiles.deepseek.apiKey, 'deep-key');

  const due = new Date(Date.now() + 3600_000).toISOString();
  const decision = context.test.parseChatDecision(JSON.stringify({ reply: '记下了。', notes: [{
    content: '出门', remindAt: due, dailyReminderTime: null, autoDeleteAt: null,
    reminderMessage: '该出门了，路上注意安全。'
  }] }));
  assert.equal(decision.notes[0].reminderMessage, '该出门了，路上注意安全。');
  const boxedNote = context.test.parseChatDecision(JSON.stringify({ reply: '记好了', notes: [{
    content: '收好这张便签', remindAt: null, dailyReminderTime: null, autoDeleteAt: null,
    reminderMessage: null, boxId: 'default', docked: true, color: '#aabbcc'
  }], actions: [] }));
  assert.equal(boxedNote.notes[0].boxId, 'default');
  assert.equal(boxedNote.notes[0].docked, true);
  assert.equal(context.test.buildReminderNotificationMessage('出门', '路上注意安全。'), '出门\n路上注意安全。');
  const mediumReplyText = '我会先核对时间，再替你把这件重要的事记下来，并在约定的时候提醒你。'.repeat(3);
  assert.equal(context.test.parseChatDecision(JSON.stringify({ reply: mediumReplyText, notes: [] })).reply, mediumReplyText);
  const longReply = context.test.parseChatDecision(JSON.stringify({
    reply: mediumReplyText.repeat(10),
    notes: [{ content: '请保留这段超过五十字的便签原文，里面的日期、姓名和事项都不应该被聊天回复的字数限制截断。',
      remindAt: due, dailyReminderTime: null, autoDeleteAt: null, reminderMessage: null }]
  }));
  assert.equal(Array.from(longReply.reply).length, 500);
  assert.match(longReply.notes[0].content, /不应该被聊天回复的字数限制截断/);
  assert.equal(context.test.parseChatDecision(JSON.stringify({ reply: '先吃早餐。\n---\n这样更有精神。', notes: [] })).reply,
    '先吃早餐。\n这样更有精神。');
  const sticky = { content: '晨跑', dailyReminderTime: '07:00' };
  legacy.stickyNotes = [sticky];
  vm.runInContext('chatCompletion = async () => "记得带水。"; saveState = async () => {};', context);
  await context.test.prepareDailyReminderAside(sticky);
  assert.equal(sticky.reminderMessage, '晨跑\n记得带水。');

  const rememberedMessages = [{ id: 'first', role: 'user', content: '你好，斯塔，我是你的开发者', createdAt: 1 }];
  for (let index = 0; index < 18; index++) {
    rememberedMessages.push({ id: `turn-${index}`, role: index % 2 ? 'assistant' : 'user', content: `对话内容 ${index}`, createdAt: index + 2 });
  }
  rememberedMessages.push({ id: 'latest', role: 'user', content: '你还记得我是谁吗', createdAt: 30 });
  const rememberedThread = { id: 'remembered', title: '测试对话', messages: rememberedMessages, createdAt: 1, updatedAt: 30 };
  vm.runInContext('chatCompletion = async (system, user) => { globalThis.lastChatCall = { system, user }; return JSON.stringify({ reply: "你在这段对话里说，你是我的开发者。", notes: [] }); };', context);
  await context.test.askAiForChat('你还记得我是谁吗', rememberedThread);
  const rememberedContext = JSON.parse(context.lastChatCall.user);
  assert.equal(rememberedContext.conversationHistory[0].content, '你好，斯塔，我是你的开发者');
  assert.equal(rememberedContext.conversationHistory.length, rememberedMessages.length - 1);
  assert.equal(rememberedContext.question, '你还记得我是谁吗');
  assert.equal(Object.hasOwn(rememberedContext.pageState.settings, 'apiKey'), false);
  assert.equal(Object.hasOwn(rememberedContext.pageState.settings, 'providerProfiles'), false);
  assert.match(context.lastChatCall.system, /same chat/);
  assert.match(context.lastChatCall.system, /setvar::wordsCloud::不多于500/);
  assert.match(context.lastChatCall.system, /定语放在中心语前/);
  assert.match(context.lastChatCall.system, /这些性格只影响表达/);
  assert.match(context.lastChatCall.system, /吃过早餐要真诚表扬/);
  assert.match(context.lastChatCall.system, /不能凭用户一句话推荐食用不明植物/);
  assert.match(context.lastChatCall.system, /看不到、不理解、不确定/);
  assert.match(context.lastChatCall.system, /一句随口的‘好烦’不足以触发/);
  assert.match(context.lastChatCall.system, /提出具体的提示词修改方案/);
  assert.match(context.lastChatCall.system, /Return ONLY JSON/);
  assert.match(context.lastChatCall.system, /CAN change homepage clock/);

  const followupThread = { ...rememberedThread, messages: [
    { id: 'assistant-question', role: 'assistant', content: '最近吃过早餐吗？', createdAt: 1 },
    { id: 'user-answer', role: 'user', content: '吃过了', createdAt: 2 }
  ] };
  await context.test.askAiForChat('吃过了', followupThread);
  assert.equal(JSON.parse(context.lastChatCall.user).previousAssistantEndedWithQuestion, true);

  const otherThread = { ...rememberedThread, id: 'other', messages: [{ id: 'other-first', role: 'user', content: '我是另一个人', createdAt: 1 }] };
  await context.test.askAiForChat('你还记得我是谁吗', otherThread);
  assert.equal(JSON.parse(context.lastChatCall.user).conversationHistory[0].content, '我是另一个人');

  const longThread = { ...rememberedThread, messages: [rememberedMessages[0], ...Array.from({ length: 40 }, (_, index) => ({
    id: `long-${index}`, role: index % 2 ? 'assistant' : 'user', content: `第 ${index} 条：` + '内容'.repeat(600), createdAt: index + 2
  }))] };
  const bounded = context.test.buildConversationHistory(longThread, '你还记得我是谁吗');
  assert.equal(bounded.messages[0].content, '你好，斯塔，我是你的开发者');
  assert.equal(bounded.messages.at(-1).content.startsWith('第 39 条'), true);
  assert.ok(bounded.omittedMessages > 0);
  assert.ok(bounded.messages.reduce((length, message) => length + message.content.length, 0) <= 24000);

  const stored = context.test.normalizeChatMessages(Array.from({ length: 300 }, (_, index) => ({
    id: `stored-${index}`, role: 'user', content: `第 ${index} 条`, createdAt: index
  })));
  assert.equal(stored.length, 300);
  assert.equal(stored[0].content, '第 0 条');
  assert.equal(stored.at(-1).content, '第 299 条');
  assert.throws(() => context.test.parseChatDecision(JSON.stringify({ reply: '', notes: [], actions: [{ kind: 'run_script' }] })), /不支持/);
  const pageDecision = context.test.parseChatDecision(JSON.stringify({ reply: '好的', notes: [], actions: [
    { kind: 'settings', values: { showNoteOrganizer: false, slideshowSeconds: 45, shuffleBackgrounds: true } }
  ] }));
  assert.equal(pageDecision.actions.length, 1);
  await context.test.executeChatPageAction(pageDecision.actions[0]);
  assert.equal(context.test.getState().settings.showNoteOrganizer, false);
  assert.equal(context.test.getState().settings.slideshowSeconds, 45);
  assert.equal(context.test.getState().settings.shuffleBackgrounds, true);
  await context.test.executeChatPageAction({ kind: 'settings', values: { homeTextColor: '#17251e', homeTextContrast: 'strong' } });
  context.test.applyHomeTextStyle();
  assert.equal(context.test.getState().settings.homeTextColor, '#17251e');
  assert.equal(styleVars['--home-text-color'], '#17251e');
  assert.match(styleVars['--home-text-shadow'], /255, 255, 255/);
  await assert.rejects(context.test.executeChatPageAction({ kind: 'settings', values: { homeTextColor: 'red' } }), /文字颜色无效/);
  assert.equal(context.test.getState().settings.homeTextColor, '#17251e');
  await assert.rejects(context.test.executeChatPageAction({ kind: 'settings', values: { apiKey: 'model-supplied-secret' } }), /不支持修改设置/);
  assert.equal(context.test.getState().settings.apiKey, 'deep-key');
  await context.test.executeChatPageAction({ kind: 'background_urls', urls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], replace: true });
  assert.equal(context.test.getState().settings.backgroundMode, 'gallery');
  assert.equal(context.test.getState().backgroundGallery.length, 2);
  assert.equal(context.test.getState().backgroundPlaylistIds.length, 2);
  context.test.addPendingImage('upload-1', { name: 'sunset.png', type: 'image/png', size: 10 });
  await context.test.askAiForChat('用这张图作背景', rememberedThread);
  assert.equal(JSON.parse(context.lastChatCall.user).uploadedImages[0].name, 'sunset.png');
  vm.runInContext('writeBackgroundBlobs = async (items) => { globalThis.uploadedCount = items.length; };', context);
  await context.test.executeChatPageAction({ kind: 'background_uploads', ids: ['upload-1'], replace: false });
  assert.equal(context.uploadedCount, 1);
  assert.equal(context.test.getState().backgroundGallery.some((item) => item.title === 'sunset.png' && item.source === 'local'), true);
  assert.equal(context.test.getState().backgroundPlaylistIds.length, 1);
  assert.equal(context.test.getState().backgroundGallery.length, 3);
  await context.test.executeChatPageAction({ kind: 'shortcut_folder_create', title: '工作', ids: [], urls: ['https://example.com'] });
  const folder = context.test.getState().shortcutFolders.find((item) => item.title === '工作');
  assert.ok(folder);
  assert.equal(context.test.getState().shortcuts.some((item) => item.folderId === folder.id), true);
  await context.test.executeChatPageAction({ kind: 'shortcut_folder_delete', id: folder.id });
  assert.equal(context.test.getState().shortcuts.some((item) => item.url === 'https://example.com' && !item.folderId), true);
  const note = context.test.createStickyNote('旧内容');
  await context.test.executeChatPageAction({ kind: 'note_update', id: note.id, values: { content: '新的内容', color: '#aabbcc' } });
  assert.equal(note.content, '新的内容');
  assert.equal(note.color, '#aabbcc');
  await assert.rejects(context.test.executeChatPageAction({ kind: 'note_update', id: note.id, values: { color: '#112233', unknown: true } }), /不支持修改便签/);
  assert.equal(note.color, '#aabbcc');
  console.log('provider and Star passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
