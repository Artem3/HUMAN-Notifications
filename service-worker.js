const API_ORIGIN = "https://api.human.ua/v1";
const ALARM_NAME = "human-notifications-check";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_CHECK_LOG = 100;
const ASSESSMENT_DETAIL_LIMIT = 100;
const MAX_NOTIFICATION_STORAGE_BYTES = 7 * 1024 * 1024;
const MAX_BADGE_COUNT = 99;
const BADGE_BACKGROUND_COLOR = "#D93025";
const DEFAULTS = {
  email: "",
  password: "",
  intervalMinutes: 30,
  privacyConsent: false
};
const storageAccessReady = restrictStorageAccess();
void ensureAlarmExists().catch((error) => console.error("Could not ensure HUMAN alarm:", safeError(error)));
void restoreBadge().catch((error) => console.error("Could not restore HUMAN badge:", safeError(error)));

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

  if (message?.type === "mark-notifications-seen") {
    markNotificationsSeen()
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
  const old = await chrome.storage.local.get(["notifications"]);
  const hasNotificationBaseline = Array.isArray(old.notifications);
  const oldNotifications = Array.isArray(old.notifications) ? old.notifications : [];
  const knownIds = new Set(oldNotifications.filter((item) => item && item.id != null).map((item) => String(item.id)));
  const newItems = notifications.filter((item) => !knownIds.has(item.id));
  const completeHistory = mergeNotifications(oldNotifications, notifications);
  const merged = fitNotificationsToStorage(completeHistory);
  await chrome.storage.local.set({ notifications: merged });
  await chrome.storage.local.remove(["notificationIds"]);
  if (hasNotificationBaseline) await incrementUnseenCount(newItems.length);

  const details = [`Відповідь HUMAN: ${notifications.length}. Локальна історія: ${merged.length}.`];
  if (merged.length < completeHistory.length) details.push(`Видалено старих сповіщень для дотримання ліміту Chrome: ${completeHistory.length - merged.length}.`);
  if (enrichment.warnings.length) details.push(`Не вдалося визначити предмет для ${enrichment.warnings.length} тем.`);

  let assessmentsResponse = await assessmentsPromise;
  if (assessmentsResponse.status === 401) {
    await writeStatus({ state: "reauthorizing", message: "Сеанс оновлюється автоматично…", trigger });
    const loginResult = await login(settings);
    if (loginResult.ok) assessmentsResponse = await getAssessments(response.institution);
  }

  if (!assessmentsResponse.ok) {
    details.push(`Оцінки не оновлено: ${assessmentsResponse.message}`);
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
  const assessments = reconcileAssessments(detailedAssessments, summaryAssessments);
  const subjectCount = new Set(assessments.map((item) => assessmentSubject(item.data)).filter(Boolean)).size;
  await chrome.storage.local.set({ assessments });
  details.push(`Оцінки HUMAN: ${assessments.length}; предметів: ${subjectCount}; докладних записів: ${detailedAssessments.length}.`);
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
  await updateBadge(0);
  await scheduleAlarm();
}

async function restoreBadge() {
  await storageAccessReady;
  const { unseenCount = 0 } = await chrome.storage.local.get(["unseenCount"]);
  await updateBadge(unseenCount);
}

async function incrementUnseenCount(amount) {
  const increment = Math.max(0, Math.trunc(Number(amount) || 0));
  if (increment === 0) return;
  await storageAccessReady;
  const { unseenCount = 0 } = await chrome.storage.local.get(["unseenCount"]);
  await updateBadge(normalizeUnseenCount(unseenCount) + increment, true);
}

async function markNotificationsSeen() {
  await storageAccessReady;
  await updateBadge(0, true);
}

async function updateBadge(value, persist = false) {
  const count = normalizeUnseenCount(value);
  if (persist) await chrome.storage.local.set({ unseenCount: count });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND_COLOR });
  await chrome.action.setBadgeText({ text: badgeText(count) });
}

function normalizeUnseenCount(value) {
  const count = Math.trunc(Number(value) || 0);
  return Math.max(0, count);
}

function badgeText(count) {
  const normalized = normalizeUnseenCount(count);
  if (normalized === 0) return "";
  return normalized > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(normalized);
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
  const data = await chrome.storage.local.get(["settings", "status", "notifications", "assessments", "checkLog"]);
  const settings = publicSettings(data.settings || {});
  const hasConsent = settings.privacyConsent;
  return {
    settings,
    status: hasConsent ? data.status || null : null,
    notifications: hasConsent && Array.isArray(data.notifications) ? data.notifications : [],
    assessments: hasConsent && Array.isArray(data.assessments) ? data.assessments : [],
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
