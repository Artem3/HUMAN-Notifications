(() => {
  const HOME_TASK_STATUS_LABELS = Object.freeze({
    0: "Отримано",
    1: "На перевірці",
    2: "Прийнято",
    3: "Повернуто"
  });

  function isHomeworkNotification(item) {
    return String(item?.type || "").toLowerCase().startsWith("home_task_");
  }

  function isGradeNotification(item) {
    return /^grade_(home|lesson)_task$/i.test(String(item?.type || ""));
  }

  globalThis.HUMAN_SHARED = Object.freeze({
    HOME_TASK_STATUS_LABELS,
    isHomeworkNotification,
    isGradeNotification
  });
})();
