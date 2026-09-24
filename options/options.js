const $ = (id) => document.getElementById(id);
let activeFilter = "homework";
let activeSubject = "all";
let formDirty = false;
let loadRequestId = 0;
let localReadInProgress = false;

$("extension-version").textContent = `v${chrome.runtime.getManifest().version}`;
document.addEventListener("DOMContentLoaded", () => { void initializeDashboard(); });
$("settings-form").addEventListener("submit", save);
$("settings-form").addEventListener("input", () => { formDirty = true; });
$("privacy-consent-form").addEventListener("submit", savePrivacyConsent);
$("privacy-dialog").addEventListener("cancel", declinePrivacyConsent);
$("privacy-consent").addEventListener("input", () => setPrivacyConsentError(false));
$("privacy-consent").addEventListener("change", () => setPrivacyConsentError(false));
$("privacy-decline").addEventListener("click", declinePrivacyConsent);
$("check-auth").addEventListener("click", checkAuth);
$("check-now").addEventListener("click", checkNow);
$("clear-all").addEventListener("click", clearAll);
$("download-logs").addEventListener("click", downloadLogs);
$("mark-notifications-read").addEventListener("click", markNotificationsReadLocally);
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  load({ syncSettings: false });
}));
$("subject-filter-buttons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-subject]");
  if (!button || button.disabled) return;
  activeSubject = button.dataset.subject;
  load({ syncSettings: false });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (!localReadInProgress && area === "local" && (changes.status || changes.notifications || changes.assessments || changes.checkLog || changes.unseenNotificationIds)) {
    load({ syncSettings: false });
  }
});
$("notifications-table").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-home-task-url]");
  if (button) window.open(button.dataset.homeTaskUrl, "_blank", "noopener,noreferrer");
});

async function load({ syncSettings = false } = {}) {
  const requestId = ++loadRequestId;
  const response = await chrome.runtime.sendMessage({ type: "get-state" });
  if (requestId !== loadRequestId) return;
  if (!response?.ok) return setOperationStatus("Не вдалося завантажити стан.");
  const { settings, notifications, assessments, checkLog, unseenNotificationIds } = response.state;
  setDashboardButtonsEnabled(settings.privacyConsent === true);
  if (!settings.privacyConsent || !settings.email || !settings.hasPassword) $("settings-details").open = true;
  if (syncSettings && !formDirty) {
    $("email").value = settings.email || "";
    const passwordInput = $("password");
    passwordInput.value = "";
    passwordInput.required = !settings.hasPassword;
    passwordInput.placeholder = settings.hasPassword ? "Пароль уже збережено" : "";
    $("intervalMinutes").value = settings.intervalMinutes || 30;
  }
  renderNotifications(notifications || [], assessments || [], unseenNotificationIds || []);
  renderLog(checkLog || []);
  return response.state;
}

async function initializeDashboard() {
  const state = await load({ syncSettings: true });
  if (!state?.settings?.privacyConsent) return showPrivacyDialog();
  if (!state.settings.email || !state.settings.hasPassword) return;
  try {
    await chrome.runtime.sendMessage({ type: "refresh-dashboard" });
  } catch (_error) {
    // The saved history remains visible if the service worker is restarting.
  } finally {
    await load({ syncSettings: false });
  }
}

function showPrivacyDialog() {
  setDashboardButtonsEnabled(false);
  const dialog = $("privacy-dialog");
  if (!dialog.open) dialog.showModal();
}

function setDashboardButtonsEnabled(enabled) {
  document.querySelectorAll("main button:not(#privacy-accept):not(#privacy-decline):not(#mark-notifications-read)").forEach((button) => { button.disabled = !enabled; });
}

function declinePrivacyConsent(event) {
  event?.preventDefault();
  $("privacy-dialog").close();
  setDashboardButtonsEnabled(false);
}

async function savePrivacyConsent(event) {
  event.preventDefault();
  const consent = $("privacy-consent");
  if (!consent.checked) {
    setPrivacyConsentError(true);
    return;
  }
  setPrivacyConsentError(false);
  const button = $("privacy-accept");
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "save-privacy-consent" });
    if (!response?.ok) throw new Error(response?.error || "розширення не відповіло");
    $("privacy-dialog").close();
    await initializeDashboard();
  } catch (error) {
    setOperationError(`Не вдалося зберегти згоду: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
}

function setPrivacyConsentError(visible) {
  $("privacy-consent-error").hidden = !visible;
}

async function markNotificationsReadLocally() {
  if ($("mark-notifications-read").disabled) return;
  localReadInProgress = true;
  document.querySelectorAll(".notification-new-dot").forEach((dot) => dot.classList.add("is-clearing"));
  hideFilterCount(activeFilter);
  renderLocalReadButton(false);
  try {
    const response = await chrome.runtime.sendMessage({ type: "mark-notifications-read-locally", category: activeFilter });
    if (!response?.ok) throw new Error(response?.error || "розширення не відповіло");
    await new Promise((resolve) => setTimeout(resolve, 190));
    await load({ syncSettings: false });
  } catch (error) {
    setOperationError(`Не вдалося позначити сповіщення прочитаними: ${error instanceof Error ? error.message : String(error)}`);
    await load({ syncSettings: false });
  } finally {
    localReadInProgress = false;
  }
}

async function save(event) {
  event.preventDefault();
  if (!validateSettingsForm()) return;
  setOperationStatus("Зберігаємо налаштування…", true);
  if (!await saveCurrentSettings()) return;
  await load({ syncSettings: true });
  setOperationStatus("✓ Налаштування збережено.", false, true);
}

async function checkAuth() {
  if (!validateSettingsForm()) return;
  setOperationStatus("Зберігаємо налаштування…", true);
  if (!await saveCurrentSettings()) return;
  setOperationStatus("Перевіряємо авторизацію…", true);
  const response = await chrome.runtime.sendMessage({ type: "check-auth" });
  await load({ syncSettings: true });
  if (!response?.ok) return setOperationError(response?.error || "Авторизацію не перевірено.");
  if (response.result?.state === "ok") return setOperationStatus("✓ Авторизація успішна.", false, true);
  setOperationError(response.result?.message || "Авторизацію не виконано.");
}

async function checkNow() {
  if (!validateSettingsForm()) return;
  setOperationStatus("Зберігаємо налаштування…", true);
  if (!await saveCurrentSettings()) return;
  setOperationStatus("Перевіряємо HUMAN…", true);
  const response = await chrome.runtime.sendMessage({ type: "check-now" });
  if (!response?.ok) return setOperationError(`Перевірку не завершено: ${response?.error || "розширення не відповіло. Натисніть Reload на сторінці розширень Chrome."}`);
  if (response.result?.state !== "ok") {
    await load({ syncSettings: false });
    return setOperationError(response.result?.message || "Перевірку завершено не повністю.");
  }
  setOperationStatus("✓ Сповіщення й оцінки завантажено.", false, true);
  await load();
}

async function saveCurrentSettings() {
  const response = await chrome.runtime.sendMessage({ type: "save-settings", settings: readForm() });
  if (!response?.ok) {
    setOperationError(`Не вдалося зберегти налаштування: ${response?.error || "розширення не відповіло. Натисніть Reload на сторінці розширень Chrome."}`);
    return false;
  }
  formDirty = false;
  return true;
}

async function clearAll() {
  if (!confirm("Видалити всі дані розширення? Логін і пароль HUMAN залишаться. Сповіщення, журнал і налаштування інтервалу буде скинуто.")) return;
  setOperationStatus("Скидаємо дані…", true);
  const response = await chrome.runtime.sendMessage({ type: "clear-all" });
  if (!response?.ok) return setOperationError(`Не вдалося скинути дані: ${response?.error || "розширення не відповіло. Натисніть Reload на сторінці розширень Chrome."}`);
  formDirty = false;
  await load({ syncSettings: true });
  setOperationStatus("✓ Усі дані скинуто. Логін і пароль збережено.", false, true);
}

async function downloadLogs() {
  const button = $("download-logs");
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-state" });
    if (!response?.ok) throw new Error(response?.error || "розширення не відповіло");
    const state = response.state || {};
    const storageBytesUsed = await getStorageBytesUsed();
    const payload = {
      diagnosticsVersion: 1,
      exportedAt: new Date().toISOString(),
      extension: {
        version: chrome.runtime.getManifest().version,
        manifestVersion: chrome.runtime.getManifest().manifest_version
      },
      storage: { localBytesUsed: storageBytesUsed },
      settings: { intervalMinutes: state.settings?.intervalMinutes ?? null },
      notificationCount: Array.isArray(state.notifications) ? state.notifications.length : 0,
      assessmentCount: Array.isArray(state.assessments) ? state.assessments.length : 0,
      lastStatus: exportableStatus(state.status),
      logs: Array.isArray(state.checkLog) ? state.checkLog.map(exportableLog) : []
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `human-notifications-logs-${fileTimestamp(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setOperationStatus("✓ Журнал збережено у файл.", false, true);
  } catch (error) {
    setOperationError(`Не вдалося завантажити журнал: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
}

async function getStorageBytesUsed() {
  try {
    if (typeof chrome.storage?.local?.getBytesInUse !== "function") return null;
    return await chrome.storage.local.getBytesInUse(null);
  } catch (_error) {
    return null;
  }
}

function exportableStatus(status) {
  return status ? exportableLog(status) : null;
}
function exportableLog(item = {}) {
  return {
    at: item.at || null,
    trigger: item.trigger || null,
    state: item.state || null,
    message: item.message || null,
    detail: item.detail || null,
    httpStatus: item.httpStatus ?? null,
    count: item.count ?? null,
    newCount: item.newCount ?? null,
    gradeCount: item.gradeCount ?? null,
    subjectCount: item.subjectCount ?? null,
    durationMs: item.durationMs ?? null
  };
}
function fileTimestamp(date) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function readForm() { return { email: $("email").value, password: $("password").value, intervalMinutes: $("intervalMinutes").value }; }
function validateSettingsForm() {
  const emailInput = $("email");
  const passwordInput = $("password");
  const intervalInput = $("intervalMinutes");
  if (!emailInput.validity.valid) {
    setOperationError("Вкажіть коректний email HUMAN.");
    emailInput.focus();
    return false;
  }
  if (passwordInput.required && !passwordInput.value) {
    setOperationError("Вкажіть пароль HUMAN.");
    passwordInput.focus();
    return false;
  }
  if (!intervalInput.validity.valid) {
    setOperationError("Інтервал має бути цілим числом від 5 до 1440 хв.");
    intervalInput.focus();
    return false;
  }
  return true;
}
function setOperationStatus(text, loading = false, success = false, error = false) { const element = $("operation-status"); element.textContent = text; element.classList.toggle("loading", loading); element.classList.toggle("success", success); element.classList.toggle("error", error); }
function setOperationError(text) { setOperationStatus(text, false, false, true); }
function renderNotifications(notifications, assessments, unseenNotificationIds) {
  const isGrades = activeFilter === "grades";
  const unseenIds = new Set(unseenNotificationIds.map((id) => String(id)));
  const subjectPalette = buildSubjectPalette([...notifications, ...assessments]);
  const categoryNotifications = isGrades ? assessments : notifications.filter(isHomeworkNotification);
  const homeworkNewCount = notifications.filter((item) => isHomeworkNotification(item) && unseenIds.has(String(item.id))).length;
  const gradeNewCount = notifications.filter((item) => isGradeNotification(item) && unseenIds.has(String(item.id))).length;
  renderFilterCount("homework", homeworkNewCount);
  renderFilterCount("grades", gradeNewCount);
  renderLocalReadButton(isGrades ? gradeNewCount > 0 : homeworkNewCount > 0);
  const allSubjects = [...subjectPalette.keys()];
  document.querySelector(".notifications-table-wrap").classList.toggle("grades-table", isGrades);
  $("notifications-head").innerHTML = isGrades
    ? "<tr><th>№</th><th>Дата й час</th><th>Предмет</th><th>Тема</th><th>Оцінка</th></tr>"
    : "<tr><th>№</th><th>Дата й час</th><th>Предмет</th><th>Тема</th><th class=\"home-task-action\">Відкрити</th></tr>";
  const availableSubjects = new Set(categoryNotifications.map((item) => subjectName(item.data || {})).filter((value) => value !== "—"));
  const visibleSubject = availableSubjects.has(activeSubject) ? activeSubject : "all";
  $("subject-filter-buttons").innerHTML = [
    `<button type="button" class="subject-filter all-subject${visibleSubject === "all" ? " active" : ""}" style="background:#edf1f4;color:#52616b;border-color:#b9c5cc" data-subject="all">Усі</button>`,
    ...allSubjects.map((subject) => {
      const colors = subjectPalette.get(subject);
      const unavailable = !availableSubjects.has(subject);
      const unavailableAttributes = unavailable ? ' disabled aria-disabled="true" title="У цій вкладці ще немає даних із предмета"' : "";
      return `<button type="button" class="subject-filter${visibleSubject === subject ? " active" : ""}" style="${subjectButtonStyle(colors)}" data-subject="${escapeHtml(subject)}"${unavailableAttributes}>${escapeHtml(subject)}</button>`;
    })
  ].join("");
  const visible = categoryNotifications.filter((item) => visibleSubject === "all" || subjectName(item.data || {}) === visibleSubject);
  const visibleRows = visible;
  const todayKey = dateKey(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dateKey(yesterday);
  const dayDividerIndex = visibleRows.findIndex((item, index) => dateKey(item.createdAt) === todayKey && dateKey(visibleRows[index + 1]?.createdAt) === yesterdayKey);
  const rows = visibleRows.map((item, index) => {
    const data = item.data || {};
    const subject = subjectName(data);
    const colors = subjectPalette.get(subject);
    const rowClass = colors ? "subject-row" : "";
    const rowStyle = colors ? ` style="--subject-bg:${colors.background}"` : "";
    const dividerClass = index === dayDividerIndex ? " day-divider" : "";
    const homeTaskUrlValue = homeTaskUrl(item, isGrades);
    const title = escapeHtml(notificationTitle(data));
    const actionCell = !isGrades
      ? `<td class="home-task-action">${homeTaskUrlValue ? `<button type="button" class="home-task-open" data-home-task-url="${escapeHtml(homeTaskUrlValue)}" aria-label="Відкрити домашнє завдання в HUMAN" title="Відкрити в HUMAN">${homeTaskOpenIcon()}</button>` : "—"}</td>`
      : "";
    const number = visibleRows.length - index;
    const isNew = isGrades ? unseenIds.has(String(data.notificationId || "")) : unseenIds.has(String(item.id));
    const newDot = isNew
      ? '<span class="notification-new-dot" aria-label="Нове сповіщення" title="Нове сповіщення"></span>'
      : '<span class="notification-new-dot is-placeholder" aria-hidden="true"></span>';
    const cells = `<td class="notification-number"><span class="notification-number-content"><span>${number}</span>${newDot}</span></td><td class="date-cell">${formatDate(item.createdAt)}</td><td>${escapeHtml(courseName(data))}</td><td>${title}</td>`;
    return `<tr class="${rowClass}${dividerClass}"${rowStyle}>${cells}${isGrades ? `<td class="grade-cell"><span class="${gradeClass(data)}">${escapeHtml(gradeValue(data))}</span></td>` : actionCell}</tr>`;
  }).join("");
  $("notifications-table").innerHTML = rows || '<tr><td colspan="5">Даних ще немає.</td></tr>';
}
function renderFilterCount(filter, count) {
  const button = document.querySelector(`.filter[data-filter="${filter}"]`);
  const badge = button.querySelector(".filter-count");
  if (count <= 0) {
    hideFilterCount(filter);
    return;
  }
  if (badge) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.remove("is-clearing");
    return;
  }
  button.insertAdjacentHTML("beforeend", `<span class="filter-count">${escapeHtml(count > 99 ? "99+" : String(count))}</span>`);
}
function hideFilterCount(filter) {
  const badge = document.querySelector(`.filter[data-filter="${filter}"] .filter-count`);
  if (!badge || badge.classList.contains("is-clearing")) return;
  badge.classList.add("is-clearing");
  window.setTimeout(() => {
    if (badge.classList.contains("is-clearing")) badge.remove();
  }, 190);
}
function renderLocalReadButton(hasNewNotifications) {
  const button = $("mark-notifications-read");
  button.disabled = !hasNewNotifications;
  button.innerHTML = hasNewNotifications ? eyeOpenIcon() : eyeClosedIcon();
  button.setAttribute("aria-label", hasNewNotifications ? "Позначити всі нові сповіщення прочитаними локально" : "Нових сповіщень немає");
  button.title = hasNewNotifications ? "Позначити всі нові прочитаними" : "Нових сповіщень немає";
}
function eyeOpenIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>'; }
function eyeClosedIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 6.2A10.9 10.9 0 0 1 12 6c6.1 0 9.5 6 9.5 6a17.4 17.4 0 0 1-3.2 3.8M6.1 6.2A17.2 17.2 0 0 0 2.5 12S5.9 18 12 18c1.4 0 2.6-.3 3.7-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'; }
function renderLog(checkLog) {
  const rows = checkLog.slice(0, 100).map((item) => {
    const count = item.newCount == null ? "—" : escapeHtml(String(item.newCount));
    const countCell = Number(item.newCount) > 0 ? `<strong>${count}</strong>` : count;
    return `<tr><td>${escapeHtml(formatLogDate(item.at))}</td><td>${countCell}</td><td>${escapeHtml(logResult(item))}</td></tr>`;
  }).join("");
  $("check-log").innerHTML = rows || '<tr><td colspan="3">Перевірок ще немає.</td></tr>';
}
function isHomeworkNotification(item) {
  return String(item?.type || "").toLowerCase().startsWith("home_task_");
}
function isGradeNotification(item) {
  return /^grade_(home|lesson)_task$/i.test(String(item?.type || ""));
}
function displaySubjectName(value) {
  return value === "Математика (Алгебра і початки аналізу та геометрія)" ? "Математика" : value;
}
function courseName(data) { return displaySubjectName(data.subjectName ?? data.subject ?? data.courseName ?? data.courseTitle ?? data.course_name ?? data.groupName ?? data.groupTitle ?? data.group_name ?? "—"); }
function subjectName(data) { return displaySubjectName(data.subjectName ?? data.subject ?? data.courseName ?? data.courseTitle ?? data.course_name ?? "—"); }
const SUBJECT_COLORS = [
  { background: "#f3e6da", text: "#765f50", border: "#d9c0aa" },
  { background: "#eff0d8", text: "#69704d", border: "#cdd0a9" },
  { background: "#e2f0df", text: "#5e765b", border: "#b9d0b5" },
  { background: "#dff0e9", text: "#527367", border: "#b4d0c5" },
  { background: "#f1e6d9", text: "#76624f", border: "#d8c0a9" },
  { background: "#e9efd8", text: "#65714e", border: "#c5d0a8" },
  { background: "#e8efe7", text: "#5d7160", border: "#bcd0bd" },
  { background: "#f0e0e7", text: "#765c68", border: "#d3b9c4" },
  { background: "#f2ead4", text: "#756943", border: "#d8cba3" },
  { background: "#dfeedd", text: "#5d735c", border: "#b7cfb7" },
  { background: "#f3e1d7", text: "#785c52", border: "#d9b9ac" },
  { background: "#ece7db", text: "#6e6653", border: "#cec5ae" },
  { background: "#dfece6", text: "#557267", border: "#b8cec4" },
  { background: "#f0e3dc", text: "#735f56", border: "#d5beb3" },
  { background: "#e7efd8", text: "#64714f", border: "#c2cea9" },
  { background: "#f1dfe3", text: "#775a64", border: "#d6b9c1" },
  { background: "#e1eee0", text: "#5d725e", border: "#b9cfb9" },
  { background: "#f1e8d7", text: "#74654d", border: "#d6c5aa" },
  { background: "#e4eee5", text: "#5c7060", border: "#bad0bd" },
  { background: "#f0e4da", text: "#745f52", border: "#d5beac" }
];
const SPECIAL_SUBJECT_COLORS = {
  "Інформатика": { background: "#f4ddd8", text: "#785d55", border: "#d9b8b0" },
  "Фізика": { background: "#d9ecd9", text: "#5d735c", border: "#b2cdb2" }
};
function buildSubjectPalette(notifications) {
  const subjects = [...new Set(notifications.map((item) => subjectName(item.data || {})).filter((value) => value !== "—"))].sort((a, b) => a.localeCompare(b, "uk"));
  let colorIndex = 0;
  return new Map(subjects.map((subject) => {
    const specialColor = SPECIAL_SUBJECT_COLORS[subject];
    if (specialColor) {
      colorIndex += 1;
      return [subject, specialColor];
    }
    const color = SUBJECT_COLORS[colorIndex % SUBJECT_COLORS.length];
    colorIndex += 1;
    return [subject, color];
  }));
}
function subjectButtonStyle(colors) { return `background:${colors.background};color:${colors.text};border-color:${colors.border}`; }
function homeTaskOpenIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>'; }
function homeTaskUrl(item, isGrades) {
  if (isGrades || !String(item.type || "").startsWith("home_task_")) return "";
  const themeId = String(item.data?.theme_id ?? "").trim();
  const homeTaskId = String(item.data?.homeTaskId ?? "").trim();
  if (!/^\d+$/.test(themeId) || !/^\d+$/.test(homeTaskId)) return "";
  return `https://lms.human.ua/lesson/${themeId}?tab=${homeTaskId}&type=home-task&notificationType=student`;
}
function gradeValue(data) { return data.gradeDisplayValue ?? data.gradeValue ?? data.gradeGrade ?? "—"; }
function gradeClass(data) {
  const value = Number(String(gradeValue(data)).trim().replace(",", "."));
  return `grade-value${Number.isInteger(value) && value >= 10 && value <= 12 ? " grade-high" : ""}`;
}
function notificationTitle(data) { return data.title ?? data.name ?? data.themeTitle ?? data.theme_title ?? data.lessonTitle ?? data.lessonName ?? data.activityTypeName ?? data.activity_type_name ?? data.message ?? "—"; }
function logResult(item) {
  const detail = item.detail ? `. ${item.detail}` : "";
  if (item.httpStatus) return `${item.httpStatus} ${httpStatusText(item.httpStatus)}${detail}`;
  if (item.state === "ok") return `200 OK${detail}`;
  if (item.state === "network_error") return `Network error${detail}`;
  if (item.state === "auth_failed") return `401 Unauthorized${detail}`;
  if (item.state === "not_configured") return "Не налаштовано";
  return `${item.detail || item.message || item.state || "—"}${detail && !item.detail ? detail : ""}`;
}
function httpStatusText(status) { return ({ 200: "OK", 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests", 500: "Server Error" })[status] || ""; }
function formatDate(value) { if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.getTime())) return "—"; const pad = (number) => String(number).padStart(2, "0"); const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`; if (dateKey(date) === dateKey(new Date())) return time; const weekdays = ["нд.", "пн.", "вт.", "ср.", "чт.", "пт.", "сб."]; return `${time}<br>${pad(date.getDate())}.${pad(date.getMonth() + 1)} (${weekdays[date.getDay()]})`; }
function dateKey(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) return ""; return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function formatLogDate(value) { if (!value) return "—"; const date = new Date(value); if (Number.isNaN(date.getTime())) return "—"; const pad = (number) => String(number).padStart(2, "0"); return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
