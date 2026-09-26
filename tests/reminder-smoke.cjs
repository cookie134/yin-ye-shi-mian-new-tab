const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const alarms = new Map();
const calls = [];
const notifications = [];
const data = { edgeAiNewTabState: null };
let permission = 'granted';
const chrome = {
  storage: { local: {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.map((key) => [key, data[key]]));
    },
    async set(value) { Object.assign(data, value); }
  } },
  alarms: {
    async create(name, options) {
      calls.push({ name, options });
      alarms.set(name, { name, scheduledTime: options.when, periodInMinutes: options.periodInMinutes });
    },
    async clear(name) { return alarms.delete(name); },
    async get(name) { return alarms.get(name); },
    async getAll() { return [...alarms.values()]; },
    onAlarm: { addListener(handler) { chrome.alarmListener = handler; } }
  },
  notifications: {
    async getPermissionLevel() { return permission; },
    async create(id, options) { notifications.push({ id, options }); return id; }
  },
  runtime: { getURL(name) { return name; }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
  contextMenus: { onClicked: { addListener() {} } },
  action: { onClicked: { addListener() {} } },
  tabs: { async create() {} }
};
const nodes = {};
const document = { getElementById(id) { return nodes[id] ||= { addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {}, contains() { return false; } } }; } };
const appSource = fs.readFileSync(path.join(root, 'dist/app.js'), 'utf8').replace('void boot();', '');
const appContext = { chrome, document, window: {}, crypto: require('node:crypto').webcrypto, structuredClone, console, Intl, Date, URL, localStorage: {} };
vm.createContext(appContext);
vm.runInContext(appSource + ';globalThis.test={setState:(value)=>{state=value},scheduleReminder,syncStickyNoteAlarms};', appContext);
(async () => {
  const now = Date.now();
  const reminder = { id: 'r1', remindAt: now + 5000, status: 'active' };
  const dueAlarm = 'reminder:r1';
  alarms.set(dueAlarm, { name: dueAlarm, scheduledTime: reminder.remindAt });
  appContext.test.setState({ reminders: [reminder], stickyNotes: [] });
  await appContext.test.scheduleReminder(reminder);
  assert.equal(calls.length, 0, 'existing imminent reminder must not be postponed');

  const currentMinute = new Date();
  const hhmm = String(currentMinute.getHours()).padStart(2, '0') + ':' + String(currentMinute.getMinutes()).padStart(2, '0');
  currentMinute.setSeconds(0, 0);
  const note = { id: 'n1', content: '出门', reminderMessage: '该出门了，路上注意安全。', dailyReminderTime: hhmm, expiresAt: null };
  const dailyAlarm = 'sticky-reminder:n1';
  alarms.set(dailyAlarm, { name: dailyAlarm, scheduledTime: currentMinute.getTime(), periodInMinutes: 1440 });
  appContext.test.setState({ reminders: [], stickyNotes: [note] });
  await appContext.test.syncStickyNoteAlarms(note);
  assert.equal(calls.length, 0, 'pending daily alarm must not move to tomorrow');
  assert.equal(alarms.get(dailyAlarm).scheduledTime, currentMinute.getTime());

  const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8').replace(/^import .*\r?\n/m, '');
  const backgroundContext = { chrome, console: { error() {}, warn() {} }, Date, URL, crypto: require('node:crypto').webcrypto };
  vm.createContext(backgroundContext);
  vm.runInContext(backgroundSource + ';globalThis.test={handleAlarm,restoreReminderAlarms};', backgroundContext);
  data.edgeAiNewTabState = { reminders: [], stickyNotes: [note] };
  await backgroundContext.test.restoreReminderAlarms();
  assert.equal(alarms.get(dailyAlarm).scheduledTime, currentMinute.getTime(), 'worker restore must preserve pending daily alarm');
  await backgroundContext.test.handleAlarm({ name: dailyAlarm });
  assert.equal(notifications.at(-1).options.title, '斯塔 · 每日提醒');
  assert.equal(notifications.at(-1).options.message, '该出门了，路上注意安全。');

  const expired = { id: 'n2', content: '出门', expiresAt: now - 1, dailyReminderTime: '' };
  const overdue = { id: 'r2', sourceNote: 'n2', status: 'active', remindAt: now - 1, title: '出门', message: '记得出门' };
  data.edgeAiNewTabState = { reminders: [overdue], stickyNotes: [expired] };
  await backgroundContext.test.handleAlarm({ name: 'reminder:r2' });
  assert.equal(notifications.at(-1).options.title, '斯塔 · 出门');
  assert.equal(data.edgeAiNewTabState.stickyNotes.length, 0, 'note expires only after notification accepted');

  permission = 'denied';
  const blocked = { id: 'r3', status: 'active', remindAt: now - 1, title: 'blocked', message: 'blocked' };
  data.edgeAiNewTabState = { reminders: [blocked], stickyNotes: [] };
  await backgroundContext.test.handleAlarm({ name: 'reminder:r3' });
  assert.equal(blocked.notifiedAt, undefined, 'denied notification must remain pending');
  assert.equal(alarms.has('reminder:r3'), true, 'denied notification must retry');
  console.log('reminder smoke passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
