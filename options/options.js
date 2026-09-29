const $ = (id) => document.getElementById(id);
let activeFilter = "homework";
let activeSubject = "all";
let formDirty = false;
let loadRequestId = 0;
let localReadInProgress = false;
let faviconRequestId = 0;
let faviconImagePromise = null;
let lastSuccessfulCheckAt = null;
let quickCheckState = "idle";
let quickCheckConfigured = false;
let checkAgeTimerId = null;
const NEW_MARKER_TRANSITION_MS = 300;
const renderedSubjectBadgeKeysByCategory = new Map();

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
$("quick-check").addEventListener("click", quickCheckNow);
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  void logUiEvent(activeFilter === "grades" ? "category-grades" : "category-homework");
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  load({ syncSettings: false });
}));
$("subject-filter-buttons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-subject]");
  if (!button || button.disabled) return;
  activeSubject = button.dataset.subject;
  void logUiEvent("subject-filter", activeSubject === "all" ? "Предмет: усі." : `Предмет: ${activeSubject}.`);
  load({ syncSettings: false });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (!localReadInProgress && area === "local" && (changes.status || changes.notifications || changes.assessments || changes.checkLog || changes.unseenNotificationIds)) {
    load({ syncSettings: false });
  }
});
$("notifications-table").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-home-task-url]");
  if (button) {
    void logUiEvent("open-home-task");
    window.open(button.dataset.homeTaskUrl, "_blank", "noopener,noreferrer");
  }
});

async function load({ syncSettings = false } = {}) {
  const requestId = ++loadRequestId;
  const response = await chrome.runtime.sendMessage({ type: "get-state" });
  if (requestId !== loadRequestId) return;
  if (!response?.ok) return setOperationStatus("Не вдалося завантажити стан.");
  const { settings, notifications, assessments, checkLog, unseenNotificationIds } = response.state;
  setDashboardButtonsEnabled(settings.privacyConsent === true);
  renderQuickCheckState(checkLog || [], settings);
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
  void renderTabFavicon(unseenNotificationIds || []);
  renderLog(checkLog || []);
  return response.state;
}

function renderQuickCheckState(checkLog, settings) {
  quickCheckConfigured = settings?.privacyConsent === true && Boolean(settings.email) && settings.hasPassword === true;
  const latestSuccessfulCheck = (Array.isArray(checkLog) ? checkLog : []).find((item) => item?.operation === "CHECK" && ["ok", "partial"].includes(item.state) && item.at);
  const nextSuccessfulCheckAt = latestSuccessfulCheck?.at || null;
  if (quickCheckState === "error" && nextSuccessfulCheckAt && nextSuccessfulCheckAt !== lastSuccessfulCheckAt) quickCheckState = "idle";
  lastSuccessfulCheckAt = nextSuccessfulCheckAt;
  updateQuickCheckDisplay();
  if (checkAgeTimerId === null) checkAgeTimerId = window.setInterval(updateQuickCheckDisplay, 60_000);
}

function updateQuickCheckDisplay() {
  const button = $("quick-check");
  const label = $("last-check-age");
  button.disabled = !quickCheckConfigured || quickCheckState === "checking";
  button.textContent = quickCheckState === "checking" ? "Перевіряємо…" : "Перевірити зараз";
  button.setAttribute("aria-busy", quickCheckState === "checking" ? "true" : "false");
  if (quickCheckState === "checking") {
    label.textContent = "Триває перевірка…";
    return;
  }
  if (quickCheckState === "error") {
    label.textContent = "Не вдалося перевірити";
    return;
  }
  if (!lastSuccessfulCheckAt) {
    label.textContent = "Ще не перевірялося";
    label.removeAttribute("title");
    return;
  }
  const checkedAt = new Date(lastSuccessfulCheckAt);
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - checkedAt.getTime()) / 60_000));
  label.textContent = elapsedMinutes < 1
    ? "Перевірено щойно"
    : elapsedMinutes < 60
      ? `Перевірено ${elapsedMinutes} хв тому`
      : "Перевірено понад годину тому";
  label.title = checkedAt.toLocaleString("uk-UA");
}

async function quickCheckNow() {
  if (!quickCheckConfigured || quickCheckState === "checking") return;
  quickCheckState = "checking";
  updateQuickCheckDisplay();
  await logUiEvent("check-now");
  try {
    const response = await chrome.runtime.sendMessage({ type: "check-now" });
    if (!response?.ok) throw new Error(response?.error || "розширення не відповіло");
    if (!["ok", "partial"].includes(response.result?.state)) throw new Error(response.result?.message || "перевірку не завершено");
    quickCheckState = "idle";
    await load({ syncSettings: false });
  } catch (error) {
    quickCheckState = "error";
    updateQuickCheckDisplay();
    setOperationError(`Перевірку не завершено: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function renderTabFavicon(unseenNotificationIds) {
  const favicon = $("page-favicon");
  if (!favicon) return;
  const count = new Set((Array.isArray(unseenNotificationIds) ? unseenNotificationIds : []).map((id) => String(id).trim()).filter(Boolean)).size;
  const requestId = ++faviconRequestId;
  if (count === 0) {
    favicon.href = "../icons/human-icon-v4-32.png";
    return;
  }
  try {
    const image = await loadFaviconImage();
    if (requestId !== faviconRequestId) return;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0, 64, 64);
    context.fillStyle = "#d93025";
    context.beginPath();
    context.arc(49, 15, 16, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = "#ffffff";
    context.stroke();
    const badgeText = count > 9 ? "9+" : String(count);
    context.fillStyle = "#ffffff";
    context.font = badgeText.length > 1 ? "800 18px system-ui, sans-serif" : "800 24px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(badgeText, 49, 15.5);
    favicon.href = canvas.toDataURL("image/png");
  } catch (_error) {
    if (requestId === faviconRequestId) favicon.href = "../icons/human-icon-v4-32.png";
  }
}

function loadFaviconImage() {
  if (faviconImagePromise) return faviconImagePromise;
  faviconImagePromise = new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", reject, { once: true });
    image.src = "../icons/human-icon-v4-32.png";
  });
  return faviconImagePromise;
}

async function initializeDashboard() {
  const navigationType = performance.getEntriesByType("navigation")[0]?.type;
  await logUiEvent(navigationType === "reload" ? "dashboard-reload" : navigationType === "back_forward" ? "dashboard-history" : "dashboard-open");
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
  void logUiEvent("privacy-decline");
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
  void logUiEvent("privacy-accept");
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
  document.querySelectorAll(".new-notification-row").forEach((row) => row.classList.add("is-clearing"));
  document.querySelectorAll(".subject-filter-count").forEach((badge) => badge.classList.add("is-clearing"));
  hideFilterCount(activeFilter);
  renderLocalReadButton(false);
  try {
    const response = await chrome.runtime.sendMessage({ type: "mark-notifications-read-locally", category: activeFilter });
    if (!response?.ok) throw new Error(response?.error || "розширення не відповіло");
    await new Promise((resolve) => setTimeout(resolve, NEW_MARKER_TRANSITION_MS + 10));
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
  void logUiEvent("save-settings");
  if (!validateSettingsForm()) return;
  setOperationStatus("Зберігаємо налаштування…", true);
  if (!await saveCurrentSettings()) return;
  await load({ syncSettings: true });
  setOperationStatus("✓ Налаштування збережено.", false, true);
}

async function checkAuth() {
  void logUiEvent("check-auth");
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
  void logUiEvent("check-now");
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
  if (!confirm("Видалити всі дані розширення? Логін і пароль HUMAN залишаться. Сповіщення, журнал і налаштування інтервалу буде скинуто.")) {
    void logUiEvent("clear-all-cancel");
    return;
  }
  setOperationStatus("Скидаємо дані…", true);
  const response = await chrome.runtime.sendMessage({ type: "clear-all" });
  if (!response?.ok) return setOperationError(`Не вдалося скинути дані: ${response?.error || "розширення не відповіло. Натисніть Reload на сторінці розширень Chrome."}`);
  await logUiEvent("clear-all-complete");
  formDirty = false;
  await load({ syncSettings: true });
  setOperationStatus("✓ Усі дані скинуто. Логін і пароль збережено.", false, true);
}

async function downloadLogs() {
  const button = $("download-logs");
  button.disabled = true;
  try {
    await logUiEvent("download-logs");
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
    operation: item.operation || null,
    level: item.level || null,
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

async function logUiEvent(action, detail = "") {
  try {
    const response = await chrome.runtime.sendMessage({ type: "log-ui-event", action, detail });
    return response?.ok === true;
  } catch (_error) {
    return false;
  }
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
  const newCountBySubject = countNewNotificationsBySubject(categoryNotifications, unseenIds, isGrades);
  const previousSubjectBadgeKeys = renderedSubjectBadgeKeysByCategory.get(activeFilter) || new Set();
  const subjectBadgeKeys = new Set();
  $("notifications-panel").classList.toggle("grades-panel", isGrades);
  $("category-filters").classList.toggle("grades-category", isGrades);
  document.querySelector(".notifications-table-wrap").classList.toggle("grades-table", isGrades);
  $("notifications-head").innerHTML = isGrades
    ? "<tr><th>№</th><th>Дата й час</th><th>Предмет</th><th>Тема</th><th>Оцінка</th></tr>"
    : "<tr><th>№</th><th>Дата й час</th><th>Предмет</th><th>Тема</th><th class=\"home-task-action\">Відкрити</th></tr>";
  const availableSubjects = new Set(categoryNotifications.map((item) => subjectName(item.data || {})).filter((value) => value !== "—"));
  const visibleSubject = availableSubjects.has(activeSubject) ? activeSubject : "all";
  $("subject-filter-buttons").innerHTML = [
    `<button type="button" class="subject-filter all-subject${visibleSubject === "all" ? " active" : ""}" style="background:#edf1f4;color:#52616b;border-color:#b9c5cc" data-subject="all" data-label="Усі"><span class="subject-filter-label">Усі</span></button>`,
    ...allSubjects.map((subject) => {
      const colors = subjectPalette.get(subject);
      const unavailable = !availableSubjects.has(subject);
      const newCount = newCountBySubject.get(subject) || 0;
      const unavailableAttributes = unavailable ? ' disabled aria-disabled="true" title="У цій вкладці ще немає даних із предмета"' : "";
      const badgeKey = `${subject}\u0000${newCount}`;
      const isAppearing = newCount > 0 && !previousSubjectBadgeKeys.has(badgeKey);
      if (newCount > 0) subjectBadgeKeys.add(badgeKey);
      const newBadge = newCount > 0 ? `<span class="subject-filter-count${isAppearing ? " is-appearing" : ""}" aria-label="${escapeHtml(`Нових сповіщень: ${newCount}`)}">${escapeHtml(newCount > 99 ? "99+" : String(newCount))}</span>` : "";
      return `<button type="button" class="subject-filter${visibleSubject === subject ? " active" : ""}${newCount > 0 ? " has-new-subject" : ""}" style="${subjectButtonStyle(colors)}" data-subject="${escapeHtml(subject)}" data-label="${escapeHtml(subject)}"${unavailableAttributes}><span class="subject-filter-label">${escapeHtml(subject)}</span>${newBadge}</button>`;
    })
  ].join("");
  renderedSubjectBadgeKeysByCategory.set(activeFilter, subjectBadgeKeys);
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
    const rowStyle = colors ? ` style="--subject-bg:${colors.background}"` : "";
    const homeTaskUrlValue = homeTaskUrl(item, isGrades);
    const title = escapeHtml(notificationTitle(data));
    const actionCell = !isGrades
      ? `<td class="home-task-action">${homeTaskUrlValue ? `<button type="button" class="home-task-open" data-home-task-url="${escapeHtml(homeTaskUrlValue)}" aria-label="Відкрити домашнє завдання в HUMAN" title="Відкрити в HUMAN">${homeTaskOpenIcon()}</button>` : "—"}</td>`
      : "";
    const number = visibleRows.length - index;
    const isNew = isGrades ? unseenIds.has(String(data.notificationId || "")) : unseenIds.has(String(item.id));
    const rowClasses = [colors ? "subject-row" : "", isNew ? "new-notification-row" : "", index === dayDividerIndex ? "day-divider" : ""].filter(Boolean).join(" ");
    const cells = `<td class="notification-number"><span class="notification-number-content"><span>${number}</span></span></td><td class="date-cell">${formatDate(item.createdAt)}</td><td class="subject-cell">${escapeHtml(courseName(data))}</td><td>${title}</td>`;
    return `<tr class="${rowClasses}"${rowStyle}>${cells}${isGrades ? `<td class="grade-cell"><span class="${gradeClass(data)}">${escapeHtml(gradeValue(data))}</span></td>` : actionCell}</tr>`;
  }).join("");
  $("notifications-table").innerHTML = rows || '<tr><td colspan="5">Даних ще немає.</td></tr>';
  queueBadgeReveal();
}
function countNewNotificationsBySubject(items, unseenIds, isGrades) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const data = item?.data || {};
    const notificationId = isGrades ? data.notificationId : item?.id;
    if (!unseenIds.has(String(notificationId || ""))) continue;
    const subject = subjectName(data);
    if (subject === "—") continue;
    counts.set(subject, (counts.get(subject) || 0) + 1);
  }
  return counts;
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
  button.insertAdjacentHTML("beforeend", `<span class="filter-count is-appearing">${escapeHtml(count > 99 ? "99+" : String(count))}</span>`);
}
function queueBadgeReveal() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.querySelectorAll(".filter-count.is-appearing, .subject-filter-count.is-appearing").forEach((badge) => badge.classList.remove("is-appearing"));
    });
  });
}
function hideFilterCount(filter) {
  const badge = document.querySelector(`.filter[data-filter="${filter}"] .filter-count`);
  if (!badge || badge.classList.contains("is-clearing")) return;
  badge.classList.add("is-clearing");
  window.setTimeout(() => {
    if (badge.classList.contains("is-clearing")) badge.remove();
  }, NEW_MARKER_TRANSITION_MS + 10);
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
  const rows = checkLog.filter((item) => item?.operation !== "UI").slice(0, 100).map((item) => {
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
  if (item.state === "user_action") return `${item.message || "Дія користувача"}${detail}`;
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
