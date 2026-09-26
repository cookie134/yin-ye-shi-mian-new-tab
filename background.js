import { consumeSnippet, fillSnippetQueue } from "./dist/snippet-queue.js";

const STORAGE_KEY = "edgeAiNewTabState";
const SNIPPET_ALARM_NAME = "snippet-prefetch";
const ALARM_PREFIX = "reminder:";
const STICKY_REMINDER_ALARM_PREFIX = "sticky-reminder:";
const STICKY_EXPIRE_ALARM_PREFIX = "sticky-expire:";
const TEST_ALARM_NAME = "notification-test";
const TEST_RESULT_KEY = "edgeAiReminderTestResult";
const DELIVERY_RESULT_KEY = "edgeAiReminderDeliveryResult";
const SAVE_SHORTCUT_MENU_ID = "save-shortcut-to-new-tab";
const SAVE_TAB_MENU_ID = "save-tab-to-new-tab";

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
  void restoreReminderAlarms().catch((error) => console.error("提醒恢复失败:", error));
  startSnippetWarmup();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
  void restoreReminderAlarms().catch((error) => console.error("提醒恢复失败:", error));
  startSnippetWarmup();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm).catch((error) => console.error("提醒闹钟处理失败:", alarm.name, error));
});

async function handleAlarm(alarm) {
  if (alarm.name === SNIPPET_ALARM_NAME) {
    await fillSnippetQueue();
  } else if (alarm.name === TEST_ALARM_NAME) {
    await notifyTestAlarm();
  } else if (alarm.name.startsWith(ALARM_PREFIX)) {
    await notifyReminder(alarm.name.slice(ALARM_PREFIX.length));
  } else if (alarm.name.startsWith(STICKY_REMINDER_ALARM_PREFIX)) {
    await notifyStickyNote(alarm.name.slice(STICKY_REMINDER_ALARM_PREFIX.length));
  } else if (alarm.name.startsWith(STICKY_EXPIRE_ALARM_PREFIX)) {
    await expireStickyNote(alarm.name.slice(STICKY_EXPIRE_ALARM_PREFIX.length));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "snippet.consume") {
    void consumeSnippet().then((snippet) => {
      sendResponse({ snippet });
      void fillSnippetQueue().catch((error) => console.warn("短句队列补充失败:", error));
    }).catch((error) => {
      console.warn("预备短句读取失败:", error);
      sendResponse({ snippet: null });
    });
    return true;
  }
  if (message?.type === "snippet.warm") {
    void fillSnippetQueue().then(() => sendResponse({ ready: true })).catch((error) => {
      console.warn("短句队列预生成失败:", error);
      sendResponse({ ready: false });
    });
    return true;
  }
  return false;
});

async function ensureSnippetAlarm() {
  if (!await chrome.alarms.get(SNIPPET_ALARM_NAME)) {
    await chrome.alarms.create(SNIPPET_ALARM_NAME, { periodInMinutes: 2 });
  }
}

function startSnippetWarmup() {
  void ensureSnippetAlarm().catch((error) => console.warn("短句后台任务注册失败:", error));
  void fillSnippetQueue().catch((error) => console.warn("短句队列补充失败:", error));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== SAVE_SHORTCUT_MENU_ID && info.menuItemId !== SAVE_TAB_MENU_ID) return;
  void saveShortcutFromContext(info, tab);
});

chrome.action?.onClicked?.addListener((tab) => {
  void saveCurrentTabFromAction(tab);
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    registerContextMenu({
      id: SAVE_SHORTCUT_MENU_ID,
      title: "收藏到我的新标签页",
      contexts: ["page", "link"]
    });
    registerContextMenu({
      id: SAVE_TAB_MENU_ID,
      title: "收藏到我的新标签页",
      contexts: ["tab"]
    });
  });
}

function registerContextMenu(properties) {
  try {
    chrome.contextMenus.create(properties, () => {
      if (chrome.runtime.lastError) console.warn("收藏菜单注册失败:", chrome.runtime.lastError.message);
    });
  } catch (error) {
    console.warn("收藏菜单注册失败:", error);
  }
}

async function saveCurrentTabFromAction(tab) {
  const result = await saveShortcutFromContext({}, tab);
  const message = result === "saved"
    ? "已加入因夜失眠标签页收藏栏。"
    : result === "exists"
      ? "这个网页已经在收藏栏中。"
      : "当前标签页没有可收藏的网页地址。";
  await chrome.notifications.create("shortcut-feedback:" + Date.now(), {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "因夜失眠标签页收藏",
    message,
    priority: 0
  });
}

async function restoreReminderAlarms() {
  const state = await readState();
  if (!state) {
    return;
  }

  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const stickyNotes = Array.isArray(state.stickyNotes) ? state.stickyNotes : [];
  const now = Date.now();
  await Promise.all(
    [
      ...reminders
      .filter((reminder) => reminder.status === "active" && !reminder.notifiedAt && Number.isFinite(reminder.remindAt))
      .map((reminder) => ensureSingleAlarm(`${ALARM_PREFIX}${reminder.id}`, reminder.remindAt, now)),
      ...stickyNotes.flatMap((note) => buildStickyNoteAlarms(note, now, reminders))
    ]
  );
}

async function ensureSingleAlarm(name, when, now) {
  const existing = await chrome.alarms.get(name);
  if (existing && existing.scheduledTime > now - 60 * 1000 &&
      (when <= now || Math.abs(existing.scheduledTime - when) < 1000)) return;
  await chrome.alarms.create(name, { when: Math.max(when, now + 30 * 1000) });
}

async function ensureDailyAlarm(name, when, localTime) {
  const existing = await chrome.alarms.get(name);
  const date = existing ? new Date(existing.scheduledTime) : null;
  const matches = date && existing.periodInMinutes === 24 * 60 &&
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` === localTime;
  if (!matches) await chrome.alarms.create(name, { when, periodInMinutes: 24 * 60 });
}

async function createVisibleNotification(id, title, message, priority = 1) {
  const permission = typeof chrome.notifications.getPermissionLevel === "function"
    ? await chrome.notifications.getPermissionLevel() : "granted";
  if (permission === "denied") throw new Error("Edge 已禁止此扩展显示通知");
  return chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message,
    priority
  });
}

async function recordDelivery(kind, status, error = "") {
  try {
    await chrome.storage.local.set({
      [DELIVERY_RESULT_KEY]: { kind, status, error, at: Date.now() }
    });
  } catch (storageError) {
    console.warn("通知诊断记录失败:", storageError);
  }
}

async function notifyReminder(reminderId) {
  const state = await readState();
  if (!state) return;
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const reminder = reminders.find((item) => item.id === reminderId);
  if (!reminder || reminder.status !== "active" || reminder.notifiedAt) return;
  const deliveredAt = Date.now();
  try {
    await createVisibleNotification(
      `notification:${reminder.id}:${deliveredAt}`,
      reminder.title ? `斯塔 · ${reminder.title}` : "斯塔提醒",
      reminder.message || "该处理这条备忘了。",
      2
    );
  } catch (error) {
    console.error("单次提醒通知失败:", error);
    await recordDelivery("single", "failed", String(error));
    await chrome.alarms.create(ALARM_PREFIX + reminder.id, { when: Date.now() + 5 * 60 * 1000 });
    return;
  }
  await recordDelivery("single", "accepted");
  reminder.notifiedAt = deliveredAt;
  await writeState(state);
  const notes = Array.isArray(state.stickyNotes) ? state.stickyNotes : [];
  const linkedNote = notes.find((note) => note.id === reminder.sourceNote);
  if (linkedNote && Number.isFinite(linkedNote.expiresAt) && linkedNote.expiresAt <= Date.now()) {
    await expireStickyNote(linkedNote.id, true);
  }
}

async function notifyStickyNote(noteId) {
  const state = await readState();
  if (!state) return;
  const stickyNotes = Array.isArray(state.stickyNotes) ? state.stickyNotes : [];
  const note = stickyNotes.find((item) => item.id === noteId);
  if (!note || (Number.isFinite(note.expiresAt) && note.expiresAt <= Date.now())) return;
  try {
    await createVisibleNotification(
      `sticky-note:${note.id}:${Date.now()}`,
      "斯塔 · 每日提醒",
      note.reminderMessage || note.content || "你有一张便签需要查看。"
    );
    await recordDelivery("daily", "accepted");
  } catch (error) {
    console.error("每日便签通知失败:", error);
    await recordDelivery("daily", "failed", String(error));
  }
}

async function notifyTestAlarm() {
  try {
    await createVisibleNotification(
      `notification-test:${Date.now()}`,
      "斯塔定时测试",
      "这条通知说明后台闹钟已触发。"
    );
    await chrome.storage.local.set({ [TEST_RESULT_KEY]: { status: "accepted", at: Date.now() } });
  } catch (error) {
    console.error("定时测试通知失败:", error);
    await chrome.storage.local.set({ [TEST_RESULT_KEY]: { status: "failed", at: Date.now(), error: String(error) } });
  }
}
async function expireStickyNote(noteId, silent = false) {
  const state = await readState();
  if (!state) return;
  const stickyNotes = Array.isArray(state.stickyNotes) ? state.stickyNotes : [];
  const note = stickyNotes.find((item) => item.id === noteId);
  if (!note) return;
  const reminders = Array.isArray(state.reminders) ? state.reminders : [];
  const linkedReminders = reminders.filter((reminder) => reminder.sourceNote === noteId);
  state.stickyNotes = stickyNotes.filter((item) => item.id !== noteId);
  state.reminders = reminders.filter((reminder) => reminder.sourceNote !== noteId);
  await writeState(state);
  await Promise.allSettled([
    chrome.alarms.clear(`${STICKY_REMINDER_ALARM_PREFIX}${noteId}`),
    chrome.alarms.clear(`${STICKY_EXPIRE_ALARM_PREFIX}${noteId}`),
    ...linkedReminders.map((reminder) => chrome.alarms.clear(`${ALARM_PREFIX}${reminder.id}`))
  ]);
  if (!silent) {
    await chrome.notifications.create(`sticky-expired:${note.id}:${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "便签已定时删除",
      message: note.content ? note.content.slice(0, 80) : "一张到期便签已删除。",
      priority: 0
    });
  }
}

function buildStickyNoteAlarms(note, now, reminders) {
  if (Number.isFinite(note.expiresAt) && note.expiresAt <= now) return [];
  const alarms = [];
  const expiresAfterNotification = reminders.some((reminder) =>
    reminder.sourceNote === note.id && reminder.status === "active" && reminder.remindAt === note.expiresAt
  );
  if (Number.isFinite(note.expiresAt) && note.expiresAt > now && !expiresAfterNotification) {
    alarms.push(ensureSingleAlarm(`${STICKY_EXPIRE_ALARM_PREFIX}${note.id}`, note.expiresAt, now));
  }
  const daily = nextDailyReminderTime(note.dailyReminderTime, now);
  if (daily) {
    alarms.push(ensureDailyAlarm(`${STICKY_REMINDER_ALARM_PREFIX}${note.id}`, daily, note.dailyReminderTime));
  }
  return alarms;
}

function nextDailyReminderTime(value, now) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const date = new Date(now);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

async function saveShortcutFromContext(info, tab) {
  const url = typeof info.linkUrl === "string" ? info.linkUrl : typeof info.pageUrl === "string" ? info.pageUrl : tab?.url ?? tab?.pendingUrl ?? "";
  if (!isHttpUrl(url)) {
    return "unsupported";
  }

  const state = (await readState()) ?? {};
  const shortcuts = Array.isArray(state.shortcuts) ? state.shortcuts : [];
  if (shortcuts.some((shortcut) => shortcut.url === url)) {
    return "exists";
  }

  const title = typeof info.linkText === "string" && info.linkText.trim()
    ? info.linkText.trim()
    : typeof tab?.title === "string" && tab.title.trim()
      ? tab.title.trim()
      : new URL(url).hostname;

  state.shortcuts = [
    ...shortcuts,
    {
      id: `${Date.now().toString(36)}-${crypto.randomUUID()}`,
      title: title.slice(0, 48),
      url
    }
  ];
  await writeState(state);
  return "saved";
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? null;
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

