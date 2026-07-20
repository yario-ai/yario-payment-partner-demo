const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const logout = document.querySelector("#logout");
const run = document.querySelector("#run");
const runNote = document.querySelector("#run-note");
const progress = document.querySelector("#progress");
const checks = document.querySelector("#checks");
const resultTitle = document.querySelector("#result-title");
const resultSummary = document.querySelector("#result-summary");
const download = document.querySelector("#download");

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return body;
}

function showAuthenticated(authenticated) {
  loginView.hidden = authenticated;
  appView.hidden = !authenticated;
  logout.hidden = !authenticated;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const submit = loginForm.querySelector("button");
  submit.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(loginForm));
    await request("/api/session", { method: "POST", body: JSON.stringify(data) });
    loginForm.reset();
    showAuthenticated(true);
  } catch (error) {
    loginError.textContent = error.status === 429
      ? "Слишком много попыток. Попробуйте позднее."
      : "Неверный логин или пароль.";
  } finally {
    submit.disabled = false;
  }
});

logout.addEventListener("click", async () => {
  await request("/api/session", { method: "DELETE" }).catch(() => {});
  showAuthenticated(false);
  checks.replaceChildren();
  download.hidden = true;
});

run.addEventListener("click", async () => {
  run.disabled = true;
  progress.hidden = false;
  checks.replaceChildren();
  resultTitle.textContent = "Проверяем интеграцию…";
  resultSummary.textContent = "Выполняются реальные test-mode вызовы Yario Integration API.";
  try {
    const report = await request("/api/conformance", { method: "POST", body: "{}" });
    renderReport(report);
  } catch (error) {
    resultTitle.textContent = error.status === 409 ? "Лаборатория занята" : "Запуск не завершён";
    resultSummary.textContent = error.status === 429
      ? `Повторный запуск будет доступен через ${error.retryAfter || "несколько"} сек.`
      : error.status === 409
        ? "Другой разработчик сейчас выполняет проверку. Повторите через минуту."
        : "Тестовая среда временно недоступна. Никакие live-операции не выполнялись.";
  } finally {
    progress.hidden = true;
    run.disabled = false;
  }
});

function renderReport(report) {
  resultTitle.textContent = report.passed ? "Интеграция прошла техническую проверку" : "Найдены технические ошибки";
  const passed = report.checks.filter((item) => item.status === "passed").length;
  resultSummary.textContent = `${passed} из ${report.checks.length} проверок выполнено · среда ${report.environment} · ${new Date(report.completedAt).toLocaleString("ru-RU")}`;
  checks.replaceChildren(...report.checks.map((item) => {
    const card = document.createElement("div");
    card.className = `check ${item.status}`;
    const title = document.createElement("strong");
    title.textContent = item.code;
    const meta = document.createElement("span");
    meta.textContent = `${label(item.status)} · ${item.durationMs} ms`;
    card.append(title, meta);
    if (item.detail || item.remediation) {
      const detail = document.createElement("span");
      detail.textContent = item.detail || item.remediation;
      card.append(detail);
    }
    return card;
  }));
  download.hidden = false;
  runNote.textContent = report.passed
    ? "Техническая готовность подтверждена. Следующий шаг — отдельный legal/operator live review."
    : "Используйте remediation в отчёте и ссылки на исходный код.";
}

function label(status) {
  return status === "passed" ? "пройдено" : status === "failed" ? "ошибка" : "пропущено";
}

request("/api/session")
  .then(() => showAuthenticated(true))
  .catch(() => showAuthenticated(false));
