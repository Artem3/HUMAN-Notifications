const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workerPath = path.join(__dirname, "..", "service-worker.js");
const workerSource = fs.readFileSync(workerPath, "utf8");
const optionsHtml = fs.readFileSync(path.join(__dirname, "..", "options", "options.html"), "utf8");
const optionsSource = fs.readFileSync(path.join(__dirname, "..", "options", "options.js"), "utf8");
const optionsCss = fs.readFileSync(path.join(__dirname, "..", "options", "options.css"), "utf8");

function loadWorker() {
  const storage = {};
  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { storage.messageListener = listener; } },
      async openOptionsPage() { storage.optionsPageOpened = true; }
    },
    action: {
      onClicked: {
        addListener(listener) { storage.actionClickListener = listener; }
      }
    },
    alarms: {
      onAlarm: { addListener() {} },
      async get() { return { name: "human-notifications-check" }; },
      async clear() {},
      async create() {}
    },
    storage: {
      local: {
        async setAccessLevel({ accessLevel }) { storage.storageAccessLevel = accessLevel; },
        async get(keys) {
          if (!keys) return { ...storage };
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => key in storage).map((key) => [key, storage[key]]));
        },
        async set(values) { Object.assign(storage, values); },
        async remove(keys) { for (const key of keys) delete storage[key]; },
        async clear() { for (const key of Object.keys(storage)) delete storage[key]; }
      }
    }
  };
  const context = vm.createContext({
    chrome,
    console,
    fetch: async () => { throw new Error("network was not expected in this test"); },
    AbortController,
    clearTimeout,
    setTimeout,
    Date,
    TextEncoder,
    URL,
    URLSearchParams
  });
  vm.runInContext(workerSource, context, { filename: workerPath });
  return { context, storage };
}

test("clampInterval enforces the configured 5 minute minimum and 1440 maximum", () => {
  const { context } = loadWorker();
  assert.equal(vm.runInContext("clampInterval(1)", context), 5);
  assert.equal(vm.runInContext("clampInterval(30.6)", context), 31);
  assert.equal(vm.runInContext("clampInterval(2000)", context), 1440);
  assert.equal(vm.runInContext("clampInterval('bad')", context), 30);
});

test("clicking the toolbar icon opens the main options page", async () => {
  const { storage } = loadWorker();
  assert.equal(typeof storage.actionClickListener, "function");
  storage.actionClickListener();
  await Promise.resolve();
  assert.equal(storage.optionsPageOpened, true);
});

test("the explicit local action clears ids only in the selected category", async () => {
  const { context, storage } = loadWorker();
  storage.notifications = [
    { id: "a", type: "home_task_created" },
    { id: "b", type: "grade_home_task" }
  ];
  storage.unseenNotificationIds = ["a", "b", "a"];
  await vm.runInContext('markNotificationsReadLocally("homework")', context);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.unseenNotificationIds)), ["b"]);
  await vm.runInContext('markNotificationsReadLocally("grades")', context);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.unseenNotificationIds)), []);
});

test("dashboard only clears local new marks through its explicit eye button", () => {
  assert.match(optionsHtml, /id="mark-notifications-read"/);
  assert.match(optionsSource, /type: "mark-notifications-read-locally", category: activeFilter/);
  assert.doesNotMatch(optionsSource, /mark-notifications-seen/);
  const dashboardSource = optionsSource.slice(optionsSource.indexOf("async function initializeDashboard"), optionsSource.indexOf("function showPrivacyDialog"));
  assert.doesNotMatch(dashboardSource, /markNotificationsReadLocally/);
  assert.match(optionsSource, /renderFilterCount\("homework", homeworkNewCount\)/);
  assert.match(optionsSource, /renderFilterCount\("grades", gradeNewCount\)/);
  assert.match(optionsSource, /notification-new-dot/);
  assert.match(optionsSource, /function isGradeNotification\(item\)/);
  assert.match(optionsSource, /not\(#mark-notifications-read\)/);
  assert.match(optionsSource, /function validateSettingsForm\(\)/);
  assert.match(optionsSource, /Інтервал має бути цілим числом від 5 до 1440 хв\./);
  assert.doesNotMatch(optionsHtml, /interval-input-shell/);
  assert.match(optionsCss, /\.filter-count \{ position: absolute;/);
  assert.match(optionsCss, /\.notification-new-dot\.is-clearing/);
});

test("opening the dashboard requests an immediate refresh when credentials are saved", () => {
  assert.match(optionsSource, /async function initializeDashboard\(\)[\s\S]*?type: "refresh-dashboard"/);
  assert.match(optionsSource, /if \(!state\?\.settings\?\.privacyConsent\) return showPrivacyDialog\(\)/);
  assert.match(optionsSource, /if \(!state\.settings\.email \|\| !state\.settings\.hasPassword\) return/);
  assert.match(workerSource, /message\?\.type === "refresh-dashboard"[\s\S]*?runCheck\("dashboard-open"\)/);
});

test("HUMAN checks require privacy consent", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "student@example.com", password: "secret-password", intervalMinutes: 30, privacyConsent: false };
  const result = await vm.runInContext('runCheck("test")', context);
  assert.equal(result.state, "not_configured");
  assert.match(result.message, /Підтвердьте обробку даних/);
});

test("the privacy popup uses an inline consent error instead of browser validation", () => {
  assert.match(optionsHtml, /<dialog id="privacy-dialog"/);
  assert.match(optionsHtml, /id="privacy-consent" type="checkbox"/);
  assert.match(optionsHtml, /id="privacy-consent-error"/);
  assert.match(optionsHtml, /id="privacy-decline"/);
  assert.match(optionsHtml, /PRIVACY\.md/);
  assert.match(optionsSource, /type: "save-privacy-consent"/);
  assert.match(optionsSource, /const consent = \$\("privacy-consent"\);/);
  assert.match(optionsSource, /if \(!consent\.checked\)/);
  assert.match(optionsSource, /setPrivacyConsentError\(false\);/);
  assert.match(optionsSource, /function declinePrivacyConsent/);
  assert.match(optionsSource, /main button:not\(#privacy-accept\):not\(#privacy-decline\)/);
});

test("settings automatically open when no HUMAN account is saved", () => {
  assert.match(optionsHtml, /id="settings-details"/);
  assert.match(optionsHtml, /id="extension-version"/);
  assert.match(optionsSource, /!settings\.email\s*\|\|\s*!settings\.hasPassword/);
  assert.match(optionsSource, /\$\("settings-details"\)\.open\s*=\s*true/);
  assert.match(optionsSource, /\$\("extension-version"\)\.textContent = `v\$\{chrome\.runtime\.getManifest\(\)\.version\}`/);
  assert.match(optionsCss, /\.settings-details:not\(\[open\]\) \.extension-version \{ display: none;/);
});

test("diagnostic export includes an up-to-date local storage size", () => {
  assert.match(optionsSource, /diagnosticsVersion:\s*1/);
  assert.match(optionsSource, /chrome\.storage\.local\.getBytesInUse\(null\)/);
  assert.match(optionsSource, /storage:\s*\{ localBytesUsed: storageBytesUsed \}/);
});

test("the dashboard renders up to 100 saved diagnostic records", () => {
  assert.match(optionsSource, /checkLog\.slice\(0, 100\)/);
});

test("authentication and manual loading save the form before sending their request", () => {
  assert.match(optionsSource, /async function checkAuth\(\) \{[\s\S]*?await saveCurrentSettings\(\)/);
  assert.match(optionsSource, /async function checkNow\(\) \{[\s\S]*?await saveCurrentSettings\(\)/);
});

test("the subject column uses the Ukrainian label in the initial and rendered table headers", () => {
  assert.doesNotMatch(optionsHtml, /Курс\s*\/\s*група/);
  assert.doesNotMatch(optionsSource, /Курс\s*\/\s*група/);
  assert.match(optionsHtml, /<th>Предмет<\/th>/);
  assert.match(optionsSource, /<th>Предмет<\/th>/);
});

test("the log gives its narrow new-count column to the diagnostic result", () => {
  assert.match(optionsHtml, /<th>Час<\/th><th>Нових<\/th><th>HTTP \/ помилка<\/th>/);
  assert.match(optionsCss, /\.log-table th:nth-child\(2\), \.log-table td:nth-child\(2\) \{ width: 48px;/);
  assert.match(optionsCss, /\.log-table th:nth-child\(1\), \.log-table td:nth-child\(1\) \{ width: 136px;/);
  assert.match(optionsCss, /\.log-table \{ min-width: 560px; table-layout: fixed;/);
  assert.match(optionsSource, /const detail = item\.detail \? `\. \$\{item\.detail\}` : "";/);
});

test("a missing periodic alarm is recreated when consent is saved", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "", password: "", intervalMinutes: 45, privacyConsent: true };
  let created = null;
  context.chrome.alarms.get = async () => null;
  context.chrome.alarms.create = async (name, info) => { created = { name, info }; };
  await vm.runInContext("ensureAlarmExists()", context);
  assert.equal(created.name, "human-notifications-check");
  assert.equal(created.info.periodInMinutes, 45);
});

test("storage is restricted to trusted extension contexts", async () => {
  const { context, storage } = loadWorker();
  await vm.runInContext("restrictStorageAccess()", context);
  assert.equal(storage.storageAccessLevel, "TRUSTED_CONTEXTS");
});

test("getState never returns the stored password", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "student@example.com", password: "secret-password", intervalMinutes: 30, privacyConsent: true };
  storage.assessments = [{ id: "assessment:1" }];
  const state = await vm.runInContext("getState()", context);
  assert.equal(state.settings.email, "student@example.com");
  assert.equal(state.settings.hasPassword, true);
  assert.equal(state.settings.privacyConsent, true);
  assert.equal(Object.hasOwn(state.settings, "password"), false);
  assert.equal(state.assessments.length, 1);
  assert.equal(storage.settings.password, "secret-password");
});

test("getState hides saved HUMAN data until privacy consent is given", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "student@example.com", password: "secret-password", intervalMinutes: 30, privacyConsent: false };
  storage.notifications = [{ id: "notification:1" }];
  storage.assessments = [{ id: "assessment:1" }];
  storage.checkLog = [{ state: "ok" }];
  const state = await vm.runInContext("getState()", context);
  assert.deepEqual(JSON.parse(JSON.stringify(state.notifications)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(state.assessments)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(state.checkLog)), []);
  assert.equal(state.status, null);
});

test("saving settings with a blank password preserves the existing password", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "old@example.com", password: "secret-password", intervalMinutes: 30, privacyConsent: true };
  await vm.runInContext(`saveSettings({ email: "new@example.com", password: "", intervalMinutes: 45 })`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.settings)), {
    email: "new@example.com",
    password: "secret-password",
    intervalMinutes: 45,
    privacyConsent: true
  });
});

test("clearAll resets data but preserves the credentials used for reauthorization", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "student@example.com", password: "secret-password", intervalMinutes: 45, privacyConsent: true };
  storage.notifications = [{ id: "1" }];
  storage.assessments = [{ id: "assessment:1" }];
  storage.checkLog = [{ message: "old" }];
  await vm.runInContext("clearAll()", context);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.settings)), {
    email: "student@example.com",
    password: "secret-password",
    intervalMinutes: 30,
    privacyConsent: true
  });
  assert.equal(Object.hasOwn(storage, "notifications"), false);
  assert.equal(Object.hasOwn(storage, "assessments"), false);
  assert.equal(Object.hasOwn(storage, "checkLog"), false);
});

test("normalizeNotifications keeps valid ids and normalizes unsafe data", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`normalizeNotifications([
    { id: 42, uid: "home_task_created", created_at: "2026-09-17 13:40:08", been_read: 1, data: null },
    { id: null, uid: "ignored" }
  ])`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{
    id: "42",
    type: "home_task_created",
    createdAt: "2026-09-17 13:40:08",
    read: true,
    data: {}
  }]);
});

test("mergeNotifications replaces by id, sorts newest first, and keeps all data", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`mergeNotifications(
    [{ id: "1", createdAt: "2026-09-17 10:00:00", value: "old" }],
    [
      { id: "1", createdAt: "2026-09-17 10:01:00", value: "updated" },
      { id: "2", createdAt: "2026-09-17 10:02:00", value: "new" }
    ]
  )`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map((item) => [item.id, item.value]))), [["2", "new"], ["1", "updated"]]);
});

test("mergeNotifications does not discard notification history after 500 items", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`mergeNotifications(
    [],
    Array.from({ length: 501 }, (_, index) => ({
      id: String(index),
      createdAt: \"2026-09-17 10:00:00\"
    }))
  )`, context);
  assert.equal(result.length, 501);
});

test("normalizeAssessments keeps real subject, topic, date, and grade fields", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`normalizeAssessments([{
    id: 77,
    date_from: 1789632000,
    int_value: 11,
    group: { title: "11Б", subject: { i18n: { name: "Фізика" } } },
    theme: { id: 86270419, title: "Електричне поле" },
    lesson_task_id: 54080998
  }])`, context);
  const item = JSON.parse(JSON.stringify(result[0]));
  assert.equal(item.id, "assessment:77");
  assert.equal(item.data.subjectName, "Фізика");
  assert.equal(item.data.themeTitle, "Електричне поле");
  assert.equal(item.data.gradeDisplayValue, "11");
  assert.equal(item.data.lessonTaskId, 54080998);
  assert.match(item.createdAt, /^2026-/);
});

test("summary reconciliation restores metadata by the available subject and value match", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`(() => {
    const detailed = normalizeAssessments([
      { id: 1, int_value: 11, group: { subject: { name: "Фізика" } } },
      { id: 2, int_value: 9, group: { subject: { name: "Фізика" } } },
      { id: 3, int_value: 8, group: { subject: { name: "Історичний предмет" } } }
    ]);
    const summary = normalizeAssessmentSummary([
      { subject_name: "Фізика", assessments: { current: [{ value: "11" }, { value: "10" }] } },
      { subject_name: "Інформатика", assessments: { current: [{ value: "12" }] } }
    ]);
    return reconcileAssessments(detailed, summary);
  })()`, context);
  const values = JSON.parse(JSON.stringify(result.map((item) => [item.data.subjectName, item.data.gradeDisplayValue])));
  assert.deepEqual(values, [["Інформатика", "12"], ["Фізика", "11"], ["Фізика", "10"]]);
  const physicsEleven = result.find((item) => item.data.subjectName === "Фізика" && item.data.gradeDisplayValue === "11");
  assert.equal(physicsEleven.id, "assessment:1");
});

test("summary reconciliation attaches metadata only by a stable assessment id", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`(() => {
    const detailed = normalizeAssessments([{
      id: 77,
      int_value: 11,
      date_from: 1789632000,
      group: { subject: { name: "Фізика" } },
      theme: { title: "Електричне поле" }
    }]);
    const summary = normalizeAssessmentSummary([{
      subject_name: "Фізика",
      assessments: { current: [{ id: 77, value: "11" }] }
    }]);
    return reconcileAssessments(detailed, summary);
  })()`, context);
  const item = JSON.parse(JSON.stringify(result[0]));
  assert.equal(item.id, "assessment:77");
  assert.equal(item.data.themeTitle, "Електричне поле");
  assert.match(item.createdAt, /^2026-/);
});

test("grade notifications move their exact assessment match to the notification time", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`mergeAssessmentNotificationTimes([
    {
      id: "assessment:498801127",
      createdAt: "2026-09-07T12:30:00.000Z",
      data: { assessmentId: 498801127, subjectName: "Географія", gradeDisplayValue: "12" }
    },
    {
      id: "assessment:498702520",
      createdAt: "2026-09-22T09:30:00.000Z",
      data: { assessmentId: 498702520, subjectName: "Іноземна мова (англійська)", gradeDisplayValue: "11" }
    }
  ], [
    {
      id: "older-grade-notification",
      type: "grade_home_task",
      createdAt: "2026-09-20 14:00:00",
      data: { assessmentId: 498801127 }
    },
    {
      id: "499339884",
      type: "grade_home_task",
      createdAt: "2026-09-22 21:34:58",
      data: { assessmentId: 498801127 }
    },
    {
      id: "ignored-type",
      type: "home_task_created",
      createdAt: "2026-09-23 10:00:00",
      data: { assessmentId: 498702520 }
    },
    {
      id: "unmatched",
      type: "grade_lesson_task",
      createdAt: "2026-09-23 11:00:00",
      data: { assessmentId: 999999999 }
    }
  ])`, context);
  const merge = JSON.parse(JSON.stringify(result));
  const items = merge.items;
  assert.equal(items[0].data.assessmentId, 498801127);
  assert.equal(items[0].createdAt, "2026-09-22 21:34:58");
  assert.equal(items[0].data.assessmentCreatedAt, "2026-09-07T12:30:00.000Z");
  assert.equal(items[0].data.notificationCreatedAt, "2026-09-22 21:34:58");
  assert.equal(items[0].data.notificationId, "499339884");
  assert.equal(items[1].createdAt, "2026-09-22T09:30:00.000Z");
  assert.deepEqual(merge.diagnostics, {
    gradeNotificationCount: 3,
    gradeNotificationsWithAssessmentId: 3,
    uniqueGradeAssessmentCount: 2,
    linkedAssessmentCount: 1,
    unmatchedAssessmentCount: 1,
    notificationTimeAppliedCount: 1
  });
  assert.equal(
    vm.runInContext(`formatGradeNotificationDiagnostics(${JSON.stringify(merge.diagnostics)}, 2)`, context),
    "Нові оцінки: 2/3; з ID: 3; унік.: 2; збігів: 1; без пари: 1; оновлено: 1."
  );
});

test("notification history keeps newest entries within the byte budget", () => {
  const { context } = loadWorker();
  const result = vm.runInContext(`fitNotificationsToStorage(
    Array.from({ length: 20 }, (_, index) => ({ id: String(20 - index), createdAt: "2026-09-17", data: { text: "x".repeat(30) } })),
    350
  )`, context);
  assert.ok(result.length > 0);
  assert.ok(result.length < 20);
  assert.equal(result[0].id, "20");
  context.testNotifications = result;
  assert.ok(vm.runInContext("jsonByteLength(testNotifications)", context) <= 350);
});

test("inactive HUMAN institution statuses are rejected", () => {
  const { context } = loadWorker();
  assert.equal(vm.runInContext("isUsableInstitutionStatus(0)", context), false);
  assert.equal(vm.runInContext("isUsableInstitutionStatus('disabled')", context), false);
  assert.equal(vm.runInContext("isUsableInstitutionStatus('leaved')", context), false);
  assert.equal(vm.runInContext("isUsableInstitutionStatus(1)", context), true);
  assert.equal(vm.runInContext("isUsableInstitutionStatus('active')", context), true);
});

test("detailed assessments load only the newest metadata page", async () => {
  const { context } = loadWorker();
  let calls = 0;
  context.fetch = async (url) => {
    calls += 1;
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get("page"), "1");
    assert.equal(parsed.searchParams.get("_limit"), "100");
    const items = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, int_value: 10 }));
    return { ok: true, status: 200, async json() { return items; } };
  };
  const result = await vm.runInContext(`fetchDetailedAssessments({ id: "496946", institutionId: "123" })`, context);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 100);
  assert.equal(calls, 1);
});

test("assessment summary is requested only for the active academic year", async () => {
  const { context } = loadWorker();
  const urls = [];
  context.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.includes("/system/info?")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { academicYears: [{ id: 2025, status: 2 }, { id: 2026, status: 1 }] };
        }
      };
    }
    if (value.includes("/analytics/data/assessments/student/496946?")) {
      return { ok: true, status: 200, async json() { return { subjects: [] }; } };
    }
    if (value.includes("/analytics/assessments?")) {
      return { ok: true, status: 200, async json() { return []; } };
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const result = await vm.runInContext('getAssessments({ id: "496946", institutionId: "123" })', context);
  assert.equal(result.ok, true);
  const summaryUrl = new URL(urls.find((url) => url.includes("/analytics/data/assessments/")));
  assert.equal(summaryUrl.searchParams.get("academicYearId"), "2026");
});

test("assessment history is not requested when HUMAN has no active academic year", async () => {
  const { context } = loadWorker();
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() { return { academicYears: [{ id: 2025, status: 2 }] }; }
    };
  };
  const result = await vm.runInContext('getAssessments({ id: "496946", institutionId: "123" })', context);
  assert.equal(result.ok, false);
  assert.match(result.message, /активний навчальний рік/i);
  assert.equal(calls, 1);
});

test("a full check stores notifications and the separate complete grade source", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "student@example.com", password: "secret-password", intervalMinutes: 30, privacyConsent: true };
  storage.assessments = Array.from({ length: 3264 }, (_, index) => ({ id: `old:${index}` }));
  let notificationBatch = [{ id: 1, uid: "home_task_created", created_at: "2026-09-20T08:00:00Z", data: {} }];
  context.fetch = async (url) => {
    const value = String(url);
    let data;
    if (value.includes("/user/institutions")) {
      data = { institutions: [{ id: 496946, status: "active", institution: { id: 123, status: "active" } }] };
    } else if (value.includes("/system/info?")) {
      data = { academicYears: [{ id: 2026, status: 1 }] };
    } else if (value.endsWith("/496946/notifications")) {
      data = { notifications: notificationBatch };
    } else if (value.includes("/analytics/data/assessments/student/496946")) {
      assert.equal(new URL(value).searchParams.get("academicYearId"), "2026");
      data = { subjects: [
        { subject_name: "Фізика", assessments: { current: [{ value: "11" }] } },
        { subject_name: "Інформатика", assessments: { current: [{ value: "12" }] } }
      ] };
    } else if (value.includes("/analytics/assessments?")) {
      data = [{ id: 77, int_value: 11, group: { subject: { name: "Фізика" } }, theme: { title: "Електричне поле" } }];
    } else {
      throw new Error(`Unexpected URL: ${value}`);
    }
    return { ok: true, status: 200, async json() { return data; } };
  };
  const result = await vm.runInContext('runCheck("test")', context);
  assert.equal(result.state, "ok");
  assert.equal(result.gradeCount, 2);
  assert.equal(result.subjectCount, 2);
  assert.equal(storage.assessments.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.assessments.map((item) => item.data.subjectName).sort())), ["Інформатика", "Фізика"]);
  assert.equal(storage.checkLog[0].gradeCount, 2);
  assert.equal(storage.checkLog[0].operation, "CHECK");
  assert.equal(storage.checkLog[0].level, "INFO");
  assert.match(storage.checkLog[0].checkId, /^check-/);
  assert.match(storage.checkLog[0].detail, /^Сповіщення: 1\/1\. Оцінки: 2; предметів: 2\. Нові оцінки: 0\/0;/);
  assert.doesNotMatch(JSON.stringify(storage.checkLog), /secret-password/);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.unseenNotificationIds)), [], "the first sync establishes a baseline");

  notificationBatch = [
    { id: 2, uid: "home_task_created", created_at: "2026-09-20T09:00:00Z", data: {} },
    ...notificationBatch
  ];
  await vm.runInContext('runCheck("test")', context);
  assert.deepEqual(JSON.parse(JSON.stringify(storage.unseenNotificationIds)), ["2"]);
});

test("appendCheckLog keeps only the newest 100 records", async () => {
  const { context, storage } = loadWorker();
  for (let index = 0; index < 105; index += 1) {
    await vm.runInContext(`appendCheckLog({ trigger: "test", state: "ok", message: "${index}" })`, context);
  }
  assert.equal(storage.checkLog.length, 100);
  assert.equal(storage.checkLog[0].message, "104");
  assert.equal(storage.checkLog[0].operation, "UNKNOWN");
  assert.equal(storage.checkLog[0].level, "INFO");
  assert.equal(storage.checkLog.at(-1).message, "5");
});

test("clearAll waits for an active check before removing its results", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "student@example.com", password: "secret-password", intervalMinutes: 30, privacyConsent: true };
  storage.notifications = [{ id: "old" }];
  vm.runInContext(`activeCheckPromise = new Promise((resolve) => { globalThis.releaseActiveCheck = resolve; })`, context);
  const clearPromise = vm.runInContext("clearAll()", context);
  await Promise.resolve();
  assert.equal(storage.notifications.length, 1);
  vm.runInContext(`chrome.storage.local.set({ notifications: [{ id: "late" }] }).then(releaseActiveCheck)`, context);
  await clearPromise;
  assert.equal(Object.hasOwn(storage, "notifications"), false);
  assert.equal(storage.settings.email, "student@example.com");
});

test("safeError turns an aborted request into a useful safe message", () => {
  const { context } = loadWorker();
  assert.equal(vm.runInContext('safeError({ name: "AbortError" })', context), "Час очікування відповіді HUMAN минув.");
});

test("network failures are written to the local check log without credentials", async () => {
  const { context, storage } = loadWorker();
  storage.settings = { email: "student@example.com", password: "secret-password", intervalMinutes: 30, privacyConsent: true };
  const result = await vm.runInContext('runCheck("test")', context);
  assert.equal(result.state, "network_error");
  assert.equal(storage.checkLog[0].state, "network_error");
  assert.equal(storage.checkLog[0].operation, "CHECK");
  assert.equal(storage.checkLog[0].level, "ERROR");
  assert.match(storage.checkLog[0].checkId, /^check-/);
  assert.match(storage.checkLog[0].message, /Немає зв’язку|network/i);
  assert.doesNotMatch(JSON.stringify(storage.checkLog), /secret-password/);
});
