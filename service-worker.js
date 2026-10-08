importScripts("options/shared.js");

const API_ORIGIN = "https://api.human.ua/v1";
const ALARM_NAME = "human-notifications-check";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_CHECK_LOG = 100;
const ASSESSMENT_DETAIL_LIMIT = 100;
const HOMEWORK_STATUS_REQUEST_CONCURRENCY = 10;
// Refresh every distinct student-task card returned by HUMAN. Requests still
// run in groups of ten, so 45 current homework rows are five bounded waves,
// not 45 simultaneous connections.
const { HOME_TASK_STATUS_LABELS, isHomeworkNotification, isGradeNotification } = globalThis.HUMAN_SHARED;
const MAX_NOTIFICATION_STORAGE_BYTES = 7 * 1024 * 1024;
const MAX_ACTION_BADGE_COUNT = 99;
const ACTION_BADGE_BACKGROUND_COLOR = "#D93025";
const ACTION_BADGE_TEXT_COLOR = "#FFFFFF";
const UI_EVENT_MESSAGES = Object.freeze({
  "dashboard-open": "Відкрито Dashboard.",
  "dashboard-reload": "Перезавантажено Dashboard.",
  "dashboard-history": "Dashboard відкрито з історії вкладки.",
  "save-settings": "Натиснуто кнопку збереження налаштувань.",
  "privacy-accept": "Підтверджено згоду на обробку даних.",
  "privacy-decline": "Відхилено згоду на обробку даних.",
  "check-auth": "Натиснуто кнопку перевірки авторизації.",
  "check-now": "Натиснуто кнопку ручної перевірки HUMAN.",
  "clear-all-cancel": "Скасовано очищення даних розширення.",
  "clear-all-complete": "Очищено дані розширення.",
  "download-logs": "Натиснуто кнопку завантаження журналу.",
  "category-homework": "Відкрито вкладку домашніх завдань.",
  "category-grades": "Відкрито вкладку оцінок.",
  "subject-filter": "Вибрано фільтр предмета.",
  "open-home-task": "Відкрито домашнє завдання в HUMAN."
});
const DEFAULTS = {
  email: "",
  password: "",
  intervalMinutes: 30,
  privacyConsent: false
};
const storageAccessReady = restrictStorageAccess();
void ensureAlarmExists().catch((error) => console.error("Could not ensure HUMAN alarm:", safeError(error)));
void restoreNewNotificationBadge().catch((error) => console.error("Could not restore HUMAN notification badge:", safeError(error)));

async function restrictStorageAccess() {
  try {
    if (typeof chrome.storage?.local?.setAccessLevel === "function") {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch (error) {
    console.error("Could not restrict HUMAN storage access:", safeError(error));
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void runLifecycle("installed");
});

chrome.runtime.onStartup.addListener(() => {
  void runLifecycle("startup");
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void runCheck("scheduled").catch((error) => console.error("Scheduled HUMAN check failed:", safeError(error)));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "save-settings") {
    saveSettings(message.settings).then(async () => {
      await scheduleAlarm();
      sendResponse({ ok: true });
    }).catch(async (error) => {
      await logUnexpectedError("save-settings", error);
      sendResponse({ ok: false, error: safeError(error) });
    });
    return true;
  }

  if (message?.type === "save-privacy-consent") {
    savePrivacyConsent().then(async () => {
      await scheduleAlarm();
      sendResponse({ ok: true });
    }).catch(async (error) => {
      await logUnexpectedError("save-privacy-consent", error);
      sendResponse({ ok: false, error: safeError(error) });
    });
    return true;
  }

  if (message?.type === "check-now") {
    runCheck("manual")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message?.type === "refresh-dashboard") {
    runCheck("dashboard-open")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message?.type === "check-auth") {
    checkAuthorization()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message?.type === "get-state") {
    getState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch(async (error) => {
        await logUnexpectedError("get-state", error);
        sendResponse({ ok: false, error: safeError(error) });
      });
    return true;
  }

  if (message?.type === "clear-all") {
    clearAll()
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        await logUnexpectedError("clear-all", error);
        sendResponse({ ok: false, error: safeError(error) });
      });
    return true;
  }

  if (message?.type === "mark-notifications-read-locally") {
    markNotificationsReadLocally(message.category)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message?.type === "log-ui-event") {
    logUiEvent(message.action, message.detail)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

});

async function runLifecycle(trigger) {
  try {
    await storageAccessReady;
    await ensureDefaults();
    await scheduleAlarm();
  } catch (error) {
    await logUnexpectedError(trigger, error, "Не вдалося запустити фонові перевірки HUMAN.");
  }
}

async function ensureDefaults() {
  const current = await chrome.storage.local.get(["settings"]);
  const settings = current.settings
    ? { ...DEFAULTS, ...current.settings, intervalMinutes: clampInterval(current.settings.intervalMinutes) }
    : DEFAULTS;
  if (!current.settings || settings.intervalMinutes !== current.settings.intervalMinutes || settings.privacyConsent !== current.settings.privacyConsent) await chrome.storage.local.set({ settings });
  await chrome.storage.local.remove(["authStatus"]);
}

async function getSettings() {
  await storageAccessReady;
  const { settings = {} } = await chrome.storage.local.get(["settings"]);
  return {
    email: String(settings.email || "").trim(),
    password: String(settings.password || ""),
    intervalMinutes: clampInterval(settings.intervalMinutes),
    privacyConsent: settings.privacyConsent === true
  };
}

async function saveSettings(input = {}) {
  const settings = await getSettings();
  const enteredPassword = String(input.password ?? "");
  const next = {
    ...settings,
    email: String(input.email || "").trim(),
    password: enteredPassword === "" ? settings.password : enteredPassword,
    intervalMinutes: clampInterval(input.intervalMinutes),
    privacyConsent: settings.privacyConsent
  };
  await chrome.storage.local.set({ settings: next });
  return publicSettings(next);
}

async function savePrivacyConsent() {
  const settings = await getSettings();
  const next = { ...settings, privacyConsent: true };
  await chrome.storage.local.set({ settings: next });
  return publicSettings(next);
}

async function scheduleAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (!settings.privacyConsent) return;
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: settings.intervalMinutes,
    periodInMinutes: settings.intervalMinutes
  });
}

async function ensureAlarmExists() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  const settings = await getSettings();
  if (!settings.privacyConsent) {
    if (alarm) await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  if (alarm) return;
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: settings.intervalMinutes,
    periodInMinutes: settings.intervalMinutes
  });
}

async function checkNotifications(trigger) {
  const settings = await getSettings();
  if (!settings.privacyConsent || !settings.email || !settings.password) {
    return writeStatus({ state: "not_configured", message: "Підтвердьте обробку даних і вкажіть email та пароль HUMAN.", trigger });
  }

  await writeStatus({ state: "checking", message: "Перевіряємо сповіщення HUMAN…", trigger });
  let response = await getNotifications(settings);

  if (response.status === 401) {
    await writeStatus({ state: "reauthorizing", message: "Сеанс оновлюється автоматично…", trigger });
    const loginResult = await login(settings);
    if (!loginResult.ok) {
      return writeStatus({ state: "auth_failed", message: "Не вдалося автоматично оновити сеанс HUMAN.", detail: loginResult.message, httpStatus: loginResult.status || null, trigger });
    }
    response = await getNotifications(settings);
  }

  if (!response.ok) {
    const state = response.status === 401 ? "auth_failed" : classifyHttp(response.status);
    const message = response.status === 401 ? "Сеанс HUMAN не прийнято після оновлення." : humanHttpMessage(response.status);
    return writeStatus({ state, message, detail: response.message, httpStatus: response.status || null, trigger });
  }

  const enrichmentPromise = enrichHomeworkSubjects(normalizeNotifications(response.data.notifications || []), response.institution.id);
  const assessmentsPromise = getAssessments(response.institution);
  const enrichment = await enrichmentPromise;
  const notifications = enrichment.items;
  const old = await chrome.storage.local.get(["notifications", "unseenNotificationIds"]);
  const hasNotificationBaseline = Array.isArray(old.notifications);
  const oldNotifications = Array.isArray(old.notifications) ? old.notifications : [];
  const knownIds = new Set(oldNotifications.filter((item) => item && item.id != null).map((item) => String(item.id)));
  const newItems = notifications.filter((item) => !knownIds.has(item.id));
  const completeHistory = mergeNotifications(oldNotifications, notifications);
  const statusRefresh = await refreshHomeworkStatuses(completeHistory, response.institution.id);
  const merged = fitNotificationsToStorage(statusRefresh.items);
  const unseenNotificationIds = hasNotificationBaseline
    ? mergeUnseenNotificationIds(old.unseenNotificationIds, newItems.filter(isTrackableNotification).map((item) => item.id), merged)
    : [];
  await chrome.storage.local.set({ notifications: merged, unseenNotificationIds });
  await updateNewNotificationBadge(unseenNotificationIds);
  await chrome.storage.local.remove(["notificationIds"]);

  const details = [`Сповіщення: ${notifications.length}/${merged.length}.`];
  if (merged.length < completeHistory.length) details.push(`Видалено старих сповіщень для дотримання ліміту Chrome: ${completeHistory.length - merged.length}.`);
  if (enrichment.warnings.length) details.push(`Не вдалося визначити предмет для ${enrichment.warnings.length} тем.`);
  if (statusRefresh.warningCount) details.push(`Не вдалося оновити статус для ${statusRefresh.warningCount} завдань.`);

  let assessmentsResponse = await assessmentsPromise;
  if (assessmentsResponse.status === 401) {
    await writeStatus({ state: "reauthorizing", message: "Сеанс оновлюється автоматично…", trigger });
    const loginResult = await login(settings);
    if (loginResult.ok) assessmentsResponse = await getAssessments(response.institution);
  }

  if (!assessmentsResponse.ok) {
    details.push(`Оцінки не оновлено: ${assessmentsResponse.message}`);
    details.push(formatHomeworkStatusDiagnostics(statusRefresh.diagnostics));
    return writeStatus({
      state: "partial",
      message: "Сповіщення завантажено, але повний журнал оцінок не оновлено.",
      count: notifications.length,
      newCount: newItems.length,
      gradeCount: 0,
      subjectCount: 0,
      httpStatus: assessmentsResponse.status || response.status,
      detail: details.join(" "),
      trigger
    });
  }

  const detailedAssessments = normalizeAssessments(assessmentsResponse.detailed);
  const summaryAssessments = normalizeAssessmentSummary(assessmentsResponse.summary);
  const analyticsAssessments = reconcileAssessments(detailedAssessments, summaryAssessments);
  const assessmentMerge = mergeAssessmentNotificationTimes(analyticsAssessments, merged);
  const assessments = assessmentMerge.items;
  const subjectCount = new Set(assessments.map((item) => assessmentSubject(item.data)).filter(Boolean)).size;
  await chrome.storage.local.set({ assessments });
  details.push(`Оцінки: ${assessments.length}; предметів: ${subjectCount}.`);
  details.push(formatGradeNotificationDiagnostics(assessmentMerge.diagnostics, countGradeNotifications(notifications)));
  details.push(formatHomeworkStatusDiagnostics(statusRefresh.diagnostics));
  if (assessmentsResponse.warnings.length) details.push(assessmentsResponse.warnings.join(" "));

  return writeStatus({
    state: "ok",
    message: `Підключено. Нових сповіщень: ${newItems.length}. Оцінок: ${assessments.length}.`,
    count: notifications.length,
    newCount: newItems.length,
    gradeCount: assessments.length,
    subjectCount,
    httpStatus: response.status,
    detail: details.join(" "),
    trigger
  });
}

async function checkAuthorization() {
  const startedAt = Date.now();
  const checkId = createCheckId();
  try {
    const settings = await getSettings();
    if (!settings.privacyConsent || !settings.email || !settings.password) {
      const result = { state: "not_configured", message: "Підтвердьте обробку даних і введіть email та пароль HUMAN." };
      await appendCheckLogBestEffort({ checkId, operation: "AUTH", level: "WARN", trigger: "auth", ...result, httpStatus: null, durationMs: Date.now() - startedAt });
      return result;
    }
    const loginResult = await login(settings);
    const authStatus = loginResult.ok
      ? { state: "ok", message: "Авторизація успішна", httpStatus: loginResult.status || 200 }
      : { state: "error", message: loginResult.message || "Не вдалося увійти", detail: loginResult.message, httpStatus: loginResult.status || null };
    await appendCheckLogBestEffort({ checkId, operation: "AUTH", level: levelForState(authStatus.state), trigger: "auth", ...authStatus, durationMs: Date.now() - startedAt });
    return authStatus;
  } catch (error) {
    await logUnexpectedError("auth", error);
    throw error;
  }
}

let clearAllPromise = null;

function clearAll() {
  if (clearAllPromise) return clearAllPromise;
  const operation = clearAllInternal();
  clearAllPromise = operation.finally(() => { clearAllPromise = null; });
  return clearAllPromise;
}

async function clearAllInternal() {
  const runningCheck = activeCheckPromise;
  if (runningCheck) await runningCheck.catch(() => {});
  await storageAccessReady;
  const data = await chrome.storage.local.get(["settings"]);
  const email = String(data.settings?.email || "").trim();
  const password = String(data.settings?.password || "");
  const privacyConsent = data.settings?.privacyConsent === true;
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ settings: { ...DEFAULTS, email, password, privacyConsent } });
  await updateNewNotificationBadge([]);
  await scheduleAlarm();
}

async function markNotificationsReadLocally(category) {
  await storageAccessReady;
  const selectedCategory = category === "grades" ? "grades" : "homework";
  const data = await chrome.storage.local.get(["notifications", "unseenNotificationIds"]);
  const notificationById = new Map((Array.isArray(data.notifications) ? data.notifications : []).map((item) => [String(item?.id ?? ""), item]));
  const previousIds = normalizeUnseenNotificationIds(data.unseenNotificationIds);
  const unseenNotificationIds = previousIds.filter((id) => {
    const notification = notificationById.get(id);
    return selectedCategory === "grades" ? !isGradeNotification(notification) : !isHomeworkNotification(notification);
  });
  await chrome.storage.local.set({ unseenNotificationIds });
  await updateNewNotificationBadge(unseenNotificationIds);
  const removedCount = previousIds.length - unseenNotificationIds.length;
  await appendCheckLogBestEffort({
    operation: "UI",
    level: "INFO",
    trigger: `mark-read-${selectedCategory}`,
    state: "user_action",
    message: "Натиснуто кнопку ока.",
    detail: `Категорія: ${selectedCategory === "grades" ? "оцінки" : "домашні завдання"}. Знято позначок: ${removedCount}. Залишилось: ${unseenNotificationIds.length}.`,
    httpStatus: null
  });
  return { category: selectedCategory, removedCount, remainingCount: unseenNotificationIds.length };
}

async function logUiEvent(action, detail = "") {
  const normalizedAction = String(action || "").trim();
  const message = UI_EVENT_MESSAGES[normalizedAction];
  if (!message) throw new Error("Невідома дія інтерфейсу.");
  return appendCheckLogBestEffort({
    operation: "UI",
    level: "INFO",
    trigger: normalizedAction,
    state: "user_action",
    message,
    detail: sanitizeUiEventDetail(detail),
    httpStatus: null
  });
}

function sanitizeUiEventDetail(value) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 160);
}

async function restoreNewNotificationBadge() {
  await storageAccessReady;
  const { unseenNotificationIds } = await chrome.storage.local.get(["unseenNotificationIds"]);
  await updateNewNotificationBadge(unseenNotificationIds);
}

async function updateNewNotificationBadge(notificationIds) {
  const count = normalizeUnseenNotificationIds(notificationIds).length;
  await chrome.action.setBadgeBackgroundColor({ color: ACTION_BADGE_BACKGROUND_COLOR });
  if (typeof chrome.action.setBadgeTextColor === "function") {
    await chrome.action.setBadgeTextColor({ color: ACTION_BADGE_TEXT_COLOR });
  }
  await chrome.action.setBadgeText({ text: count === 0 ? "" : count > MAX_ACTION_BADGE_COUNT ? `${MAX_ACTION_BADGE_COUNT}+` : String(count) });
}

function normalizeUnseenNotificationIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((id) => String(id).trim()).filter(Boolean))];
}

function mergeUnseenNotificationIds(previousIds, newIds, notifications) {
  const availableIds = new Set((Array.isArray(notifications) ? notifications : []).map((item) => String(item?.id ?? "")).filter(Boolean));
  return normalizeUnseenNotificationIds([...normalizeUnseenNotificationIds(previousIds), ...normalizeUnseenNotificationIds(newIds)])
    .filter((id) => availableIds.has(id));
}

let activeCheckPromise = null;

function runCheck(trigger) {
  if (clearAllPromise) return clearAllPromise.then(() => runCheck(trigger));
  if (activeCheckPromise) return activeCheckPromise;
  const operation = runCheckInternal(trigger);
  activeCheckPromise = operation.finally(() => { activeCheckPromise = null; });
  return activeCheckPromise;
}

async function runCheckInternal(trigger) {
  const startedAt = Date.now();
  const checkId = createCheckId();
  try {
    const result = await checkNotifications(trigger);
    await appendCheckLogBestEffort({
      checkId,
      operation: "CHECK",
      level: levelForState(result.state),
      trigger,
      state: result.state,
      message: result.message,
      count: result.count || 0,
      newCount: result.newCount || 0,
      gradeCount: result.gradeCount || 0,
      subjectCount: result.subjectCount || 0,
      httpStatus: result.httpStatus || null,
      detail: result.detail || "",
      durationMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    await appendCheckLogBestEffort({
      checkId,
      operation: "CHECK",
      level: "ERROR",
      trigger,
      state: "unexpected_error",
      message: "Внутрішня помилка перевірки HUMAN.",
      detail: safeError(error),
      httpStatus: null,
      durationMs: Date.now() - startedAt
    });
    throw error;
  }
}

async function appendCheckLog(entry) {
  const { checkLog = [] } = await chrome.storage.local.get(["checkLog"]);
  const item = {
    checkId: entry.checkId || null,
    operation: entry.operation || "UNKNOWN",
    level: entry.level || levelForState(entry.state),
    ...entry,
    at: new Date().toISOString()
  };
  const previous = Array.isArray(checkLog) ? checkLog : [];
  await chrome.storage.local.set({ checkLog: [item, ...previous].slice(0, MAX_CHECK_LOG) });
  return item;
}

async function appendCheckLogBestEffort(entry) {
  try {
    return await appendCheckLog(entry);
  } catch (error) {
    console.error("Could not write HUMAN extension log:", safeError(error));
    return null;
  }
}

async function logUnexpectedError(trigger, error, message = "Внутрішня помилка розширення.") {
  return appendCheckLogBestEffort({
    checkId: createCheckId(),
    operation: "INTERNAL",
    level: "ERROR",
    trigger,
    state: "unexpected_error",
    message,
    detail: safeError(error),
    httpStatus: null
  });
}

function createCheckId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function levelForState(state) {
  if (state === "ok") return "INFO";
  if (state === "partial" || state === "not_configured" || state === "rate_limited") return "WARN";
  return "ERROR";
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function login(settings) {
  try {
    const response = await fetchWithTimeout(`${API_ORIGIN}/auth`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: settings.email, password: settings.password })
    });
    if (!response.ok) return { ok: false, status: response.status, message: `HTTP ${response.status}` };
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, message: safeError(error) };
  }
}

async function getNotifications(settings) {
  try {
    const institution = await resolveInstitutionId();
    if (!institution.ok) return { ok: false, status: institution.status, message: institution.message };
    const response = await fetchWithTimeout(`${API_ORIGIN}/${encodeURIComponent(institution.id)}/notifications`, {
      credentials: "include"
    });
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) return { ok: false, status: response.status, message: "Відповідь HUMAN не прийнято." };
    if (!data || !Array.isArray(data.notifications)) return { ok: false, status: 0, message: "Неочікуваний формат сповіщень." };
    return { ok: true, status: response.status, data, institution };
  } catch (error) {
    return { ok: false, status: 0, message: safeError(error) };
  }
}

async function getAssessments(institution) {
  const academicYearResult = await fetchActiveAcademicYear(institution);
  if (!academicYearResult.ok) {
    return academicYearResult;
  }

  const summaryResult = await fetchAssessmentSummary(institution, academicYearResult.academicYear);
  if (summaryResult.status === 401) {
    return { ok: false, status: 401, message: "Сеанс HUMAN не прийнято під час завантаження оцінок." };
  }
  if (!summaryResult.ok) {
    return { ok: false, status: summaryResult.status || 0, message: summaryResult.message };
  }

  const detailedResult = await fetchDetailedAssessments(institution);
  if (detailedResult.status === 401) {
    return { ok: false, status: 401, message: "Сеанс HUMAN не прийнято під час завантаження оцінок." };
  }
  const warnings = [];
  if (!detailedResult.ok) warnings.push(`Докладні оцінки не завантажено: ${detailedResult.message}`);
  return {
    ok: true,
    status: summaryResult.status || detailedResult.status || 200,
    summary: summaryResult.items,
    detailed: detailedResult.ok ? detailedResult.items : [],
    warnings
  };
}

async function fetchActiveAcademicYear(institution) {
  try {
    const lmsId = encodeURIComponent(institution.id);
    const response = await fetchWithTimeout(`${API_ORIGIN}/${lmsId}/system/info?expand=institution.tariffPlans,institution.institutionLtiTools,institution.owner`, {
      credentials: "include"
    });
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) return { ok: false, status: response.status, message: `Навчальний рік: HTTP ${response.status}.` };
    const academicYears = Array.isArray(data?.academicYears) ? data.academicYears : [];
    const academicYear = academicYears.find((item) => item && (item.status === 1 || String(item.status).toLowerCase() === "active"));
    if (!academicYear?.id) {
      return { ok: false, status: 0, message: "HUMAN не передав активний навчальний рік. Історію за всі роки не завантажено." };
    }
    return { ok: true, status: response.status, academicYear };
  } catch (error) {
    return { ok: false, status: 0, message: safeError(error) };
  }
}

async function fetchAssessmentSummary(institution, academicYear) {
  try {
    const userId = encodeURIComponent(institution.id);
    const params = new URLSearchParams({ academicYearId: String(academicYear.id) });
    const response = await fetchWithTimeout(`${API_ORIGIN}/${userId}/analytics/data/assessments/student/${userId}?${params}`, {
      credentials: "include"
    });
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) return { ok: false, status: response.status, message: `Оцінки HUMAN: HTTP ${response.status}.` };
    if (!data || !Array.isArray(data.subjects)) return { ok: false, status: 0, message: "Неочікуваний формат списку оцінок HUMAN." };
    return { ok: true, status: response.status, items: data.subjects };
  } catch (error) {
    return { ok: false, status: 0, message: safeError(error) };
  }
}

async function fetchDetailedAssessments(institution) {
  try {
    const params = new URLSearchParams({
      student_id: institution.id,
      learner_id: institution.id,
      _limit: String(ASSESSMENT_DETAIL_LIMIT),
      page: "1",
      sort: "-id",
      expand: "theme,learner,student,member,user,lesson_task,home_task,group.subject"
    });
    if (institution.institutionId) params.set("institution_id", institution.institutionId);
    const response = await fetchWithTimeout(`${API_ORIGIN}/${encodeURIComponent(institution.id)}/analytics/assessments?${params}`, {
      credentials: "include"
    });
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) return { ok: false, status: response.status, message: `Докладні оцінки: HTTP ${response.status}.` };
    const items = Array.isArray(data) ? data : Array.isArray(data?.assessments) ? data.assessments : null;
    if (!items) return { ok: false, status: 0, message: "Неочікуваний формат докладних оцінок." };
    return { ok: true, status: response.status, items };
  } catch (error) {
    return { ok: false, status: 0, message: safeError(error) };
  }
}

async function enrichHomeworkSubjects(items, institutionId) {
  const targets = items.filter((item) => item.type.startsWith("home_task_") && !hasSubject(item.data));
  if (!targets.length || !institutionId) return { items, warnings: [] };
  const cacheState = await chrome.storage.local.get(["themeSubjects"]);
  const themeSubjects = cacheState.themeSubjects || {};
  const warnings = [];
  const themeIds = [...new Set(targets.map((item) => item.data.theme_id || item.data.themeId).filter(Boolean).map(String))];
  const missing = themeIds.filter((id) => !(id in themeSubjects));
  for (let index = 0; index < missing.length; index += 5) {
    const batch = missing.slice(index, index + 5);
    const results = await Promise.all(batch.map((themeId) => fetchThemeSubject(institutionId, themeId)));
    batch.forEach((themeId, batchIndex) => {
      const result = results[batchIndex];
      if (result.subject) themeSubjects[themeId] = result.subject;
      else delete themeSubjects[themeId];
      if (result.warning) warnings.push(result.warning);
    });
  }
  if (missing.some((id) => themeSubjects[id])) await chrome.storage.local.set({ themeSubjects });
  return {
    items: items.map((item) => {
      if (!item.type.startsWith("home_task_") || hasSubject(item.data)) return item;
      const themeId = String(item.data.theme_id || item.data.themeId || "");
      const subject = themeSubjects[themeId];
      return subject ? { ...item, data: { ...item.data, subjectName: subject } } : item;
    }),
    warnings
  };
}

async function fetchThemeSubject(institutionId, themeId) {
  try {
    const response = await fetchWithTimeout(`${API_ORIGIN}/${encodeURIComponent(institutionId)}/plan/theme/${encodeURIComponent(themeId)}?expand=lesson_tasks.type,home_tasks.type`, { credentials: "include" });
    if (!response.ok) return { subject: "", warning: `Тема ${themeId}: HTTP ${response.status}.` };
    const subject = extractSubject(await response.json());
    return subject ? { subject, warning: "" } : { subject: "", warning: `Тема ${themeId}: предмет не знайдено у відповіді HUMAN.` };
  } catch (error) {
    return { subject: "", warning: `Тема ${themeId}: ${safeError(error)}` };
  }
}

async function refreshHomeworkStatuses(items, institutionId) {
  const sourceItems = Array.isArray(items) ? items : [];
  const allTargets = sourceItems.filter((item) => isHomeworkNotification(item) && homeTaskId(item.data));
  const targets = selectHomeworkStatusTargets(allTargets);
  const homeTaskUserIds = [...new Set(targets.map((item) => homeTaskUserId(item.data)).filter(Boolean))];
  const themeIds = [...new Set(targets.filter((item) => !homeTaskUserId(item.data)).map((item) => themeId(item.data)).filter(Boolean))];
  const selectedNotificationIds = new Set(targets.map((item) => String(item.id)));
  const diagnostics = {
    notificationCount: allTargets.length,
    selectedNotificationCount: targets.length,
    missingThemeIdCount: targets.length - targets.filter((item) => themeId(item.data)).length,
    themeCount: themeIds.length,
    detailCount: homeTaskUserIds.length,
    themeHttpStatuses: {},
    detailHttpStatuses: {},
    returnedTaskCount: 0,
    userStatusCount: 0,
    matchedNotificationCount: 0,
    statusValueCounts: {},
    updatedNotificationCount: 0
  };
  if (!institutionId) return { items: sourceItems, warningCount: 0, diagnostics };

  // A notification gives us the exact student's home-task relation. Read that
  // record first: it is the same status source that HUMAN renders on the task
  // page and avoids inferring a student from a theme-wide task list.
  const statusByHomeTaskId = new Map();
  const statusByHomeTaskUserId = new Map();
  const failedThemeIds = new Set();
  const failedHomeTaskUserIds = new Set();
  let warningCount = 0;
  const requests = [
    ...homeTaskUserIds.map((id) => ({ type: "detail", id })),
    ...themeIds.map((id) => ({ type: "theme", id }))
  ];
  for (let index = 0; index < requests.length; index += HOMEWORK_STATUS_REQUEST_CONCURRENCY) {
    const batch = requests.slice(index, index + HOMEWORK_STATUS_REQUEST_CONCURRENCY);
    const results = await Promise.all(batch.map((request) => request.type === "detail"
      ? fetchStudentHomeTaskStatus(institutionId, request.id)
      : fetchThemeHomeworkStatuses(institutionId, request.id)));
    results.forEach((result, resultIndex) => {
      if (result.warning) warningCount += 1;
      const request = batch[resultIndex];
      if (!result.ok) {
        if (request.type === "detail") failedHomeTaskUserIds.add(request.id);
        else failedThemeIds.add(request.id);
      }
      const statusKey = String(result.httpStatus || 0);
      const httpStatuses = request.type === "detail" ? diagnostics.detailHttpStatuses : diagnostics.themeHttpStatuses;
      httpStatuses[statusKey] = (httpStatuses[statusKey] || 0) + 1;
      diagnostics.returnedTaskCount += result.returnedTaskCount;
      diagnostics.userStatusCount += result.userStatusCount;
      Object.entries(result.statusValueCounts).forEach(([status, count]) => {
        diagnostics.statusValueCounts[status] = (diagnostics.statusValueCounts[status] || 0) + count;
      });
      for (const [id, status] of result.statusByHomeTaskId) statusByHomeTaskId.set(id, status);
      for (const [id, status] of result.statusByHomeTaskUserId) statusByHomeTaskUserId.set(id, status);
    });
  }

  const updatedItems = sourceItems.map((item) => {
    if (!isHomeworkNotification(item)) return item;
    if (!selectedNotificationIds.has(String(item.id))) return item;
    const taskId = homeTaskId(item.data);
    const userId = homeTaskUserId(item.data);
    if (userId ? failedHomeTaskUserIds.has(userId) : failedThemeIds.has(themeId(item.data))) return item;
    const status = userId ? statusByHomeTaskUserId.get(userId) : statusByHomeTaskId.get(taskId);
    if (status === undefined) {
      if (!Object.hasOwn(item.data || {}, "homeTaskStatus")) return item;
      const data = { ...item.data };
      delete data.homeTaskStatus;
      return { ...item, data };
    }
    diagnostics.matchedNotificationCount += 1;
    if (Number(item.data?.homeTaskStatus) !== status) diagnostics.updatedNotificationCount += 1;
    const data = { ...item.data, homeTaskStatus: status };
    delete data.homeTaskEventAt;
    return { ...item, data };
  });

  return {
    items: updatedItems,
    warningCount,
    diagnostics
  };
}

function selectHomeworkStatusTargets(items) {
  const candidates = Array.isArray(items) ? items : [];
  const selectedTargetKeys = new Set();
  for (const item of candidates) {
    const key = homeworkStatusTargetKey(item);
    if (!key || selectedTargetKeys.has(key)) continue;
    selectedTargetKeys.add(key);
  }
  return candidates.filter((item) => selectedTargetKeys.has(homeworkStatusTargetKey(item)));
}

function homeworkStatusTargetKey(item) {
  const userId = homeTaskUserId(item?.data);
  if (userId) return `user:${userId}`;
  const id = themeId(item?.data);
  return id ? `theme:${id}` : "";
}

async function fetchThemeHomeworkStatuses(institutionId, value) {
  try {
    const response = await fetchWithTimeout(`${API_ORIGIN}/${encodeURIComponent(institutionId)}/plan/theme/${encodeURIComponent(value)}?expand=home_tasks.home_tasks_users`, { credentials: "include" });
    if (!response.ok) return emptyHomeworkStatusResult(true, response.status);
    const theme = await response.json();
    if (!Array.isArray(theme?.home_tasks)) return emptyHomeworkStatusResult(true, response.status);
    return mapHomeworkTaskStatuses(theme.home_tasks, response.status, institutionId);
  } catch {
    return emptyHomeworkStatusResult(true, 0);
  }
}

async function fetchStudentHomeTaskStatus(institutionId, value) {
  try {
    const response = await fetchWithTimeout(`${API_ORIGIN}/${encodeURIComponent(institutionId)}/home-task/home-tasks-users/${encodeURIComponent(value)}`, { credentials: "include" });
    if (!response.ok) return emptyHomeworkStatusResult(true, response.status);
    const task = await response.json();
    const status = normalizeHomeTaskStatus(task?.status ?? task?.home_tasks_user?.status);
    if (status === null) return emptyHomeworkStatusResult(true, response.status);
    return {
      statusByHomeTaskId: new Map(),
      statusByHomeTaskUserId: new Map([[String(value), status]]),
      ok: true,
      warning: false,
      httpStatus: response.status,
      returnedTaskCount: 1,
      userStatusCount: 1,
      statusValueCounts: { [String(status)]: 1 }
    };
  } catch {
    return emptyHomeworkStatusResult(true, 0);
  }
}

function mapHomeworkTaskStatuses(tasks, httpStatus, currentUserId) {
  const statusByHomeTaskId = new Map();
  const statusByHomeTaskUserId = new Map();
  const statusValueCounts = {};
  let userStatusCount = 0;
  let missingUserLists = 0;
  for (const task of tasks) {
    const id = String(task?.id ?? "").trim();
    const users = task?.home_tasks_users;
    if (!Array.isArray(users)) {
      missingUserLists += 1;
      continue;
    }
    if (!id) continue;
    const ownTask = users.find((user) => String(user?.user_id ?? "") === String(currentUserId));
    const status = ownTask ? normalizeHomeTaskStatus(ownTask.status) : 0;
    if (status === null) continue;
    if (ownTask) userStatusCount += 1;
    statusValueCounts[String(status)] = (statusValueCounts[String(status)] || 0) + 1;
    statusByHomeTaskId.set(id, status);
    const userId = String(ownTask?.id ?? "").trim();
    if (userId) statusByHomeTaskUserId.set(userId, status);
  }
  return { statusByHomeTaskId, statusByHomeTaskUserId, ok: true, warning: missingUserLists > 0, httpStatus, returnedTaskCount: tasks.length, userStatusCount, statusValueCounts };
}

function emptyHomeworkStatusResult(warning, httpStatus) {
  return { statusByHomeTaskId: new Map(), statusByHomeTaskUserId: new Map(), ok: false, warning, httpStatus, returnedTaskCount: 0, userStatusCount: 0, statusValueCounts: {} };
}

function homeTaskId(data = {}) {
  return String(data.homeTaskId ?? data.home_task_id ?? data.home_task?.id ?? "").trim();
}

function homeTaskUserId(data = {}) {
  return String(data.homeTaskUserId ?? data.home_task_user_id ?? data.home_tasks_user?.id ?? "").trim();
}

function themeId(data = {}) {
  return String(data.theme_id ?? data.themeId ?? data.theme?.id ?? "").trim();
}

function normalizeHomeTaskStatus(value) {
  if (value === null || value === undefined || value === "") return null;
  const status = Number(value);
  return Number.isInteger(status) && Object.hasOwn(HOME_TASK_STATUS_LABELS, status) ? status : null;
}

function formatHomeworkStatusDiagnostics(diagnostics = {}) {
  const themeHttp = Object.entries(diagnostics.themeHttpStatuses || {}).map(([status, count]) => `${status}×${count}`).join(", ") || "кеш";
  const detailHttp = Object.entries(diagnostics.detailHttpStatuses || {}).map(([status, count]) => `${status}×${count}`).join(", ") || "кеш";
  const values = Object.entries(diagnostics.statusValueCounts || {}).map(([status, count]) => `${status}×${count}`).join(", ") || "—";
  return `Статуси ДЗ: сповіщень з ID: ${Number(diagnostics.notificationCount) || 0}; обрано: ${Number(diagnostics.selectedNotificationCount) || 0}; тем: ${Number(diagnostics.themeCount) || 0}; тема HTTP: ${themeHttp}; карток учня: ${Number(diagnostics.detailCount) || 0}; картка HTTP: ${detailHttp}; завдань: ${Number(diagnostics.returnedTaskCount) || 0}; робіт учня: ${Number(diagnostics.userStatusCount) || 0}; значення: ${values}; збігів: ${Number(diagnostics.matchedNotificationCount) || 0}; оновлено рядків: ${Number(diagnostics.updatedNotificationCount) || 0}.`;
}

function extractSubject(theme) {
  return theme?.subject?.i18n?.name || theme?.subject?.name || theme?.theme_container?.lesson_plan?.group?.subject?.i18n?.name || theme?.theme_container?.lesson_plan?.group?.subject?.name || theme?.lesson_plan?.group?.subject?.i18n?.name || theme?.lesson_plan?.group?.subject?.name || "";
}

function hasSubject(data) {
  return Boolean(data?.subjectName || data?.subject || data?.courseName || data?.courseTitle || data?.course_name);
}

async function resolveInstitutionId() {
  const response = await fetchWithTimeout(`${API_ORIGIN}/user/institutions?page=1&_limit=10&fields=status,id,institution.id,institution.status&sort=-id`, { credentials: "include" });
  if (!response.ok) return { ok: false, status: response.status, message: `Заклади HUMAN: HTTP ${response.status}.` };
  const data = await response.json();
  const institution = (Array.isArray(data?.institutions) ? data.institutions : []).find((item) => isUsableInstitutionStatus(item?.status) && isUsableInstitutionStatus(item?.institution?.status));
  return institution?.id
    ? { ok: true, id: String(institution.id), institutionId: institution.institution?.id ? String(institution.institution.id) : "" }
    : { ok: false, status: 0, message: "Не знайдено активного закладу." };
}

function isUsableInstitutionStatus(status) {
  if (status === null || status === undefined || status === "") return true;
  const normalized = String(status).trim().toLowerCase();
  return !["0", "disabled", "inactive", "leaved", "left", "blocked", "deleted"].includes(normalized);
}

function normalizeNotifications(items) {
  return items.filter((item) => item && item.id != null).map((item) => ({
    id: String(item.id),
    type: String(item.uid || "notification"),
    createdAt: item.created_at || "",
    read: Boolean(item.been_read),
    data: item.data && typeof item.data === "object" ? item.data : {}
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function mergeNotifications(oldItems, freshItems) {
  const previous = Array.isArray(oldItems) ? oldItems.filter((item) => item && item.id != null) : [];
  const incoming = Array.isArray(freshItems) ? freshItems.filter((item) => item && item.id != null) : [];
  const map = new Map(previous.map((item) => [String(item.id), item]));
  for (const item of incoming) map.set(String(item.id), item);
  return [...map.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function fitNotificationsToStorage(items, maxBytes = MAX_NOTIFICATION_STORAGE_BYTES) {
  const notifications = Array.isArray(items) ? items : [];
  if (jsonByteLength(notifications) <= maxBytes) return notifications;
  let low = 0;
  let high = notifications.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonByteLength(notifications.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return notifications.slice(0, low);
}

function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeAssessments(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && assessmentValue(item) !== "").map((item, index) => {
    const subject = extractAssessmentSubject(item);
    const createdAt = assessmentDate(item);
    const themeId = item.theme?.id ?? item.theme_id ?? item.lesson_task?.theme_id ?? item.home_task?.theme_id ?? "";
    return {
      id: `assessment:${item.id ?? `${item.entity_type || "unknown"}:${item.entity_id || index}:${createdAt}`}`,
      type: "assessment",
      createdAt,
      read: true,
      data: {
        subjectName: subject,
        courseName: subject,
        groupName: item.group?.title ?? item.group?.name ?? item.group_name ?? "",
        themeTitle: item.theme?.title ?? item.lesson_task?.title ?? item.lesson_task?.name ?? item.home_task?.title ?? item.home_task?.name ?? "",
        gradeDisplayValue: assessmentValue(item),
        assessmentId: item.id ?? "",
        lessonTaskId: item.lesson_task_id ?? item.lesson_task?.id ?? "",
        homeTaskId: item.home_task_id ?? item.home_task?.id ?? "",
        themeId
      }
    };
  }).sort(compareAssessments);
}

function normalizeAssessmentSummary(subjects) {
  const categories = ["current", "thematic", "semester_first", "semester_second", "year", "dpa"];
  const result = [];
  for (const [subjectIndex, subject] of (Array.isArray(subjects) ? subjects : []).entries()) {
    const subjectName = String(subject?.subject_name || "").trim();
    if (!subjectName) continue;
    for (const category of categories) {
      const values = Array.isArray(subject?.assessments?.[category]) ? subject.assessments[category] : [];
      values.forEach((assessment, index) => {
        const value = summaryAssessmentValue(assessment);
        if (value === "") return;
        result.push({
          id: `summary:${encodeURIComponent(subjectName)}:${category}:${index}:${encodeURIComponent(value)}`,
          type: "assessment_summary",
          createdAt: "",
          read: true,
          data: {
            subjectName,
            courseName: subjectName,
            themeTitle: "",
            gradeDisplayValue: value,
            assessmentId: assessment?.id ?? assessment?.assessment_id ?? "",
            assessmentCategory: category,
            subjectIndex
          }
        });
      });
    }
  }
  return result;
}

function reconcileAssessments(detailed, summary) {
  const detailedItems = Array.isArray(detailed) ? detailed : [];
  const summaryItems = Array.isArray(summary) ? summary : [];
  const detailedById = new Map();
  const availableBySubjectAndValue = new Map();
  for (const item of detailedItems) {
    const id = String(item?.data?.assessmentId ?? "").trim();
    if (id) detailedById.set(id, item);
    const key = assessmentMatchKey(item);
    if (!availableBySubjectAndValue.has(key)) availableBySubjectAndValue.set(key, []);
    availableBySubjectAndValue.get(key).push(item);
  }
  const result = summaryItems.map((item) => {
    const id = String(item?.data?.assessmentId ?? "").trim();
    if (id && detailedById.has(id)) return detailedById.get(id);
    const matches = availableBySubjectAndValue.get(assessmentMatchKey(item));
    return matches?.length ? matches.shift() : item;
  });
  return result.sort(compareAssessments);
}

function mergeAssessmentNotificationTimes(assessmentItems, notificationItems) {
  const latestNotifications = new Map();
  let gradeNotificationCount = 0;
  let gradeNotificationsWithAssessmentId = 0;
  for (const notification of Array.isArray(notificationItems) ? notificationItems : []) {
    if (!isGradeNotification(notification)) continue;
    gradeNotificationCount += 1;
    const assessmentId = assessmentNotificationId(notification);
    if (!assessmentId) continue;
    gradeNotificationsWithAssessmentId += 1;
    if (!notification?.createdAt) continue;
    const previous = latestNotifications.get(assessmentId);
    if (!previous || notificationTimestamp(notification.createdAt) > notificationTimestamp(previous.createdAt)) {
      latestNotifications.set(assessmentId, notification);
    }
  }

  const analyticsIds = new Set((Array.isArray(assessmentItems) ? assessmentItems : []).map(assessmentNotificationId).filter(Boolean));
  const linkedAssessmentCount = [...latestNotifications.keys()].filter((assessmentId) => analyticsIds.has(assessmentId)).length;
  const items = (Array.isArray(assessmentItems) ? assessmentItems : []).map((assessment) => {
    const notification = latestNotifications.get(assessmentNotificationId(assessment));
    if (!notification) return assessment;
    return {
      ...assessment,
      createdAt: notification.createdAt,
      data: {
        ...assessment.data,
        assessmentCreatedAt: assessment.createdAt,
        notificationCreatedAt: notification.createdAt,
        notificationId: notification.id
      }
    };
  }).sort(compareAssessments);

  return {
    items,
    diagnostics: {
      gradeNotificationCount,
      gradeNotificationsWithAssessmentId,
      uniqueGradeAssessmentCount: latestNotifications.size,
      linkedAssessmentCount,
      unmatchedAssessmentCount: latestNotifications.size - linkedAssessmentCount,
      notificationTimeAppliedCount: linkedAssessmentCount
    }
  };
}

function isTrackableNotification(item) {
  return isHomeworkNotification(item) || isGradeNotification(item);
}

function countGradeNotifications(items) {
  return (Array.isArray(items) ? items : []).filter(isGradeNotification).length;
}

function assessmentNotificationId(item) {
  return String(item?.data?.assessmentId ?? item?.data?.assessment_id ?? "").trim();
}

function notificationTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatGradeNotificationDiagnostics(diagnostics = {}, receivedGradeNotificationCount = 0) {
  return `Нові оцінки: ${Number(receivedGradeNotificationCount) || 0}/${Number(diagnostics.gradeNotificationCount) || 0}; з ID: ${Number(diagnostics.gradeNotificationsWithAssessmentId) || 0}; унік.: ${Number(diagnostics.uniqueGradeAssessmentCount) || 0}; збігів: ${Number(diagnostics.linkedAssessmentCount) || 0}; без пари: ${Number(diagnostics.unmatchedAssessmentCount) || 0}; оновлено: ${Number(diagnostics.notificationTimeAppliedCount) || 0}.`;
}

function assessmentMatchKey(item) {
  return `${assessmentSubject(item?.data).toLocaleLowerCase("uk")}\u0000${String(item?.data?.gradeDisplayValue ?? "").trim()}`;
}

function assessmentSubject(data = {}) {
  return String(data.subjectName || data.subject || data.courseName || data.courseTitle || data.course_name || "").trim();
}

function extractAssessmentSubject(item) {
  return String(
    item?.group?.subject?.i18n?.name ||
    item?.group?.subject?.name ||
    item?.group?.subject_name ||
    item?.subject?.i18n?.name ||
    item?.subject?.name ||
    item?.course_name ||
    item?.courseName ||
    ""
  ).trim();
}

function assessmentValue(item) {
  const value = item?.gradeDisplayValue ?? item?.grade_value ?? item?.value ?? item?.int_value ?? item?.assessment?.int_value;
  return value === undefined || value === null ? "" : String(value).trim();
}

function summaryAssessmentValue(item) {
  const value = item?.value ?? item?.display_value ?? item?.int_value;
  return value === undefined || value === null ? "" : String(value).trim();
}

function assessmentDate(item) {
  const value = item?.date_from ?? item?.created_at ?? item?.date ?? "";
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const milliseconds = numeric < 100000000000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return String(value);
}

function compareAssessments(a, b) {
  const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (aTime !== bTime) return bTime - aTime;
  const subjectOrder = assessmentSubject(a?.data).localeCompare(assessmentSubject(b?.data), "uk");
  return subjectOrder || String(a?.id || "").localeCompare(String(b?.id || ""));
}

async function writeStatus(status) {
  const state = { ...status, at: new Date().toISOString() };
  await chrome.storage.local.set({ status: state });
  return state;
}

async function getState() {
  await storageAccessReady;
  const data = await chrome.storage.local.get(["settings", "status", "notifications", "assessments", "checkLog", "unseenNotificationIds"]);
  const settings = publicSettings(data.settings || {});
  const hasConsent = settings.privacyConsent;
  return {
    settings,
    status: hasConsent ? data.status || null : null,
    notifications: hasConsent && Array.isArray(data.notifications) ? data.notifications : [],
    assessments: hasConsent && Array.isArray(data.assessments) ? data.assessments : [],
    unseenNotificationIds: hasConsent ? normalizeUnseenNotificationIds(data.unseenNotificationIds) : [],
    checkLog: hasConsent && Array.isArray(data.checkLog) ? data.checkLog : [],
    authStatus: null
  };
}

function publicSettings(settings = {}) {
  const password = String(settings.password || "");
  return {
    email: String(settings.email || "").trim(),
    intervalMinutes: clampInterval(settings.intervalMinutes),
    hasPassword: password.length > 0,
    privacyConsent: settings.privacyConsent === true
  };
}

function clampInterval(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.min(1440, Math.max(5, Math.round(minutes))) : DEFAULTS.intervalMinutes;
}
function classifyHttp(status) { return status === 429 ? "rate_limited" : status === 0 ? "network_error" : `http_${status}`; }
function humanHttpMessage(status) { return status === 429 ? "HUMAN просить зачекати. Наступна перевірка буде пізніше." : status === 0 ? "Немає зв’язку з HUMAN. Спробуємо пізніше." : `HUMAN повернув HTTP ${status}.`; }
function notificationTitle(type) { return ({ home_task_created: "Нове домашнє завдання", home_task_approve: "Домашнє завдання схвалено", grade_home_task: "Оцінка за домашнє завдання", grade_lesson_task: "Оцінка за завдання уроку" })[type] || "Сповіщення HUMAN"; }
function safeError(error) {
  if (error?.name === "AbortError") return "Час очікування відповіді HUMAN минув.";
  return error instanceof Error ? error.message : String(error);
}
