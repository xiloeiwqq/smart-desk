"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const TEMPLATES = {
  linear: {
    formula: "a*x+b",
    label: "Прямая",
    parameters: ["a", "b"],
  },
  quadratic: {
    formula: "a*x**2+b*x+c",
    label: "Парабола",
    parameters: ["a", "b", "c"],
  },
  inverse: {
    formula: "a/(x-b)+c",
    label: "Гипербола",
    parameters: ["a", "b", "c"],
  },
};

const dom = {
  presentation: $("#presentation"),
  inputScreen: $("#inputScreen"),
  graphScreen: $("#graphScreen"),
  systemPill: $("#systemPill"),
  systemText: $("#systemText"),
  writeCanvas: $("#writeCanvas"),
  writePlaceholder: $("#writePlaceholder"),
  penState: $("#penState"),
  undoButton: $("#undoButton"),
  clearButton: $("#clearButton"),
  strokeCount: $("#strokeCount"),
  recognizeButton: $("#recognizeButton"),
  ocrButtonHint: $("#ocrButtonHint"),
  templateList: $("#templateList"),
  formulaInput: $("#formulaInput"),
  formulaField: $("#formulaField"),
  formulaCheck: $("#formulaCheck"),
  candidateBadge: $("#candidateBadge"),
  confirmButton: $("#confirmButton"),
  graphCanvas: $("#graphCanvas"),
  graphWrap: $("#graphWrap"),
  graphEmpty: $("#graphEmpty"),
  graphTooltip: $("#graphTooltip"),
  equationChip: $("#equationChip"),
  graphFormulaLabel: $("#graphFormulaLabel"),
  pointStat: $("#pointStat"),
  gapStat: $("#gapStat"),
  resetCoefficients: $("#resetCoefficients"),
  newSessionButton: $("#newSessionButton"),
  toast: $("#toast"),
  toastText: $("#toastText"),
  toastClose: $("#toastClose"),
  helpDialog: $("#helpDialog"),
  helpButton: $("#helpButton"),
  fullscreenButton: $("#fullscreenButton"),
  backButton: $("#backButton"),
  progress: [$("#progressCompose"), $("#progressExplore")],
};

const coefficientInputs = {
  a: $("#coefficientA"),
  b: $("#coefficientB"),
  c: $("#coefficientC"),
};

const coefficientOutputs = {
  a: $("#valueA"),
  b: $("#valueB"),
  c: $("#valueC"),
};

const state = {
  strokes: [],
  activeStrokes: new Map(),
  confirmed: false,
  points: [],
  graphResponse: null,
  graphSize: { width: 0, height: 0 },
  plotArea: null,
  hoverIndex: null,
  activeTemplate: "linear",
  parameters: ["a", "b"],
  source: "template",
  inputRevision: 0,
  formulaRevision: 0,
  ocrSequence: 0,
  plotSequence: 0,
  ocrController: null,
  plotController: null,
  ocrReady: false,
  toastTimer: null,
  plotTimer: null,
};

const writeContext = dom.writeCanvas.getContext("2d", { alpha: false });
const graphContext = dom.graphCanvas.getContext("2d");


function formatNumber(value) {
  const number = Number(value);
  if (Object.is(number, -0)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(".", ",");
}


function coefficients() {
  return Object.fromEntries(
    Object.entries(coefficientInputs).map(([name, input]) => [name, Number(input.value)]),
  );
}


function normalizeClientFormula(value) {
  let formula = value.trim()
    .replaceAll("−", "-")
    .replaceAll("×", "*")
    .replaceAll("·", "*")
    .replaceAll("÷", "/")
    .replaceAll("²", "**2")
    .replaceAll("³", "**3")
    .replaceAll("^", "**")
    .replace(/\s+/g, "");
  if (formula.includes("=")) formula = formula.split("=").slice(1).join("=");
  return formula;
}


function prettyFormula(formula) {
  return formula
    .replaceAll("**2", "²")
    .replaceAll("**3", "³")
    .replaceAll("*", "·")
    .replaceAll("-", "−");
}


function equationWithValues() {
  const formula = normalizeClientFormula(dom.formulaInput.value);
  const { a, b, c } = coefficients();
  const n = formatNumber;
  if (formula === TEMPLATES.linear.formula) {
    return `y = ${n(a)}·x ${b < 0 ? "−" : "+"} ${n(Math.abs(b))}`;
  }
  if (formula === TEMPLATES.quadratic.formula) {
    return `y = ${n(a)}·x² ${b < 0 ? "−" : "+"} ${n(Math.abs(b))}·x ${c < 0 ? "−" : "+"} ${n(Math.abs(c))}`;
  }
  if (formula === TEMPLATES.inverse.formula) {
    return `y = ${n(a)}/(x ${b < 0 ? "+" : "−"} ${n(Math.abs(b))}) ${c < 0 ? "−" : "+"} ${n(Math.abs(c))}`;
  }
  let display = prettyFormula(formula);
  for (const [name, value] of Object.entries({ a, b, c })) {
    display = display.replace(new RegExp(`\\b${name}\\b`, "g"), `(${n(value)})`);
  }
  return `y = ${display}`;
}


function updateEquationLabels() {
  const equation = equationWithValues();
  dom.equationChip.textContent = equation;
  dom.graphFormulaLabel.textContent = equation;
}


function setProgress(step) {
  const visibleStep = step >= 3 ? 2 : 1;
  dom.progress.forEach((item, index) => {
    item.classList.toggle("is-active", index === visibleStep - 1);
    item.classList.toggle("is-complete", index < visibleStep - 1);
  });
}


function showScreen(screen) {
  const showGraph = screen === "graph";
  dom.presentation.dataset.screen = showGraph ? "graph" : "input";
  dom.inputScreen.toggleAttribute("inert", showGraph);
  dom.graphScreen.toggleAttribute("inert", !showGraph);
  dom.inputScreen.setAttribute("aria-hidden", String(showGraph));
  dom.graphScreen.setAttribute("aria-hidden", String(!showGraph));
  if (showGraph) {
    window.requestAnimationFrame(resizeGraphCanvas);
    window.setTimeout(resizeGraphCanvas, 740);
  }
}


function showToast(message, type = "info", duration = 4200) {
  clearTimeout(state.toastTimer);
  dom.toastText.textContent = message;
  dom.toast.classList.toggle("is-error", type === "error");
  dom.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), duration);
}


function setGraphEmpty(title = "График ждёт подтверждения", copy = "Вернитесь к формуле и подтвердите её") {
  $("strong", dom.graphEmpty).textContent = title;
  $("small", dom.graphEmpty).textContent = copy;
  dom.graphEmpty.classList.remove("is-hidden");
}


function clearGraph(message = true) {
  state.points = [];
  state.graphResponse = null;
  state.hoverIndex = null;
  dom.graphTooltip.classList.remove("is-visible");
  if (message) setGraphEmpty();
  dom.pointStat.textContent = "401 точка";
  dom.gapStat.textContent = "Разрывов нет";
  drawGraph();
}


function setConfirmed(confirmed) {
  state.confirmed = confirmed;
  dom.formulaField.classList.toggle("is-confirmed", confirmed);
  dom.confirmButton.classList.toggle("is-confirmed", confirmed);
  $("span", dom.confirmButton).textContent = confirmed ? "Формула подтверждена" : "Подтвердить и показать график";
}


function invalidateConfirmation({ clear = true, advance = true } = {}) {
  if (advance) state.formulaRevision += 1;
  if (state.plotController) state.plotController.abort();
  clearTimeout(state.plotTimer);
  setConfirmed(false);
  if (clear) clearGraph();
  setProgress(state.strokes.length ? 2 : 1);
}


function updateParameterCards(parameters = state.parameters) {
  state.parameters = parameters;
  $$(".coefficient-card").forEach((card) => {
    const used = parameters.includes(card.dataset.parameter);
    card.classList.toggle("is-unused", !used);
    $("input", card).disabled = !used;
  });
}


function selectTemplateVisual(id) {
  state.activeTemplate = id;
  $$(".template-card", dom.templateList).forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.template === id);
  });
}


function inferTemplate(formula) {
  const normalized = normalizeClientFormula(formula);
  return Object.entries(TEMPLATES).find(([, item]) => item.formula === normalized)?.[0] ?? null;
}


function updateSourceBadge(source) {
  state.source = source;
  dom.candidateBadge.classList.toggle("is-ocr", source === "ocr");
  dom.candidateBadge.textContent = source === "ocr" ? "Распознано" : source === "manual" ? "Исправлено" : "Шаблон";
}


function resetCoefficientValues() {
  coefficientInputs.a.value = "1";
  coefficientInputs.b.value = "0";
  coefficientInputs.c.value = "0";
  updateCoefficientUI();
}


function updateCoefficientUI() {
  for (const [name, input] of Object.entries(coefficientInputs)) {
    coefficientOutputs[name].textContent = formatNumber(input.value);
    const progress = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
    input.style.setProperty("--range-progress", `${progress}%`);
  }
  updateEquationLabels();
}


function canvasPoint(event) {
  const rect = dom.writeCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (dom.writeCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (dom.writeCanvas.height / rect.height),
    pressure: event.pointerType === "mouse" ? 0.5 : Math.max(0.18, event.pressure || 0.5),
  };
}


function renderWriting() {
  writeContext.fillStyle = "#f8faf5";
  writeContext.fillRect(0, 0, dom.writeCanvas.width, dom.writeCanvas.height);
  writeContext.lineCap = "round";
  writeContext.lineJoin = "round";
  writeContext.strokeStyle = "#10261e";

  for (const stroke of state.strokes) {
    if (!stroke.length) continue;
    if (stroke.length === 1) {
      const point = stroke[0];
      writeContext.beginPath();
      writeContext.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      writeContext.fillStyle = "#10261e";
      writeContext.fill();
      continue;
    }
    for (let index = 1; index < stroke.length; index += 1) {
      const previous = stroke[index - 1];
      const current = stroke[index];
      writeContext.beginPath();
      writeContext.lineWidth = 4.5 + current.pressure * 4;
      writeContext.moveTo(previous.x, previous.y);
      writeContext.lineTo(current.x, current.y);
      writeContext.stroke();
    }
  }

  const count = state.strokes.length;
  dom.writePlaceholder.classList.toggle("is-hidden", count > 0);
  dom.undoButton.disabled = count === 0;
  dom.clearButton.disabled = count === 0;
  dom.recognizeButton.disabled = count === 0;
  dom.strokeCount.textContent = count === 0 ? "Холст пуст" : `${count} ${count === 1 ? "штрих" : count < 5 ? "штриха" : "штрихов"}`;
}


function beginStroke(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (state.activeStrokes.has(event.pointerId)) return;
  event.preventDefault();
  dom.writeCanvas.setPointerCapture(event.pointerId);
  const stroke = [canvasPoint(event)];
  state.activeStrokes.set(event.pointerId, stroke);
  state.strokes.push(stroke);
  state.inputRevision += 1;
  if (state.ocrController) state.ocrController.abort();
  invalidateConfirmation();
  dom.penState.classList.add("is-drawing");
  dom.penState.lastChild.textContent = " Рисуем…";
  renderWriting();
}


function extendStroke(event) {
  const stroke = state.activeStrokes.get(event.pointerId);
  if (!stroke) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
  for (const sample of samples) stroke.push(canvasPoint(sample));
  renderWriting();
}


function endStroke(event) {
  if (!state.activeStrokes.delete(event.pointerId)) return;
  const isDrawing = state.activeStrokes.size > 0;
  dom.penState.classList.toggle("is-drawing", isDrawing);
  dom.penState.lastChild.textContent = isDrawing ? " Рисуем…" : " Перо готово";
  renderWriting();
}


function undoStroke() {
  if (!state.strokes.length) return;
  state.strokes.pop();
  state.inputRevision += 1;
  if (state.ocrController) state.ocrController.abort();
  invalidateConfirmation();
  renderWriting();
}


function clearWriting(invalidate = true) {
  for (const pointerId of state.activeStrokes.keys()) {
    if (dom.writeCanvas.hasPointerCapture(pointerId)) {
      dom.writeCanvas.releasePointerCapture(pointerId);
    }
  }
  state.strokes = [];
  state.activeStrokes.clear();
  dom.penState.classList.remove("is-drawing");
  dom.penState.lastChild.textContent = " Перо готово";
  state.inputRevision += 1;
  if (state.ocrController) state.ocrController.abort();
  if (invalidate) invalidateConfirmation();
  renderWriting();
}


async function postJSON(url, body, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Сервер вернул непонятный ответ.");
  }
  if (!response.ok) {
    const error = new Error(data.error || "Запрос не выполнен.");
    error.code = data.code;
    throw error;
  }
  return data;
}


async function recognizeWriting() {
  if (!state.strokes.length) {
    showToast("Сначала напишите формулу на доске.", "error");
    return;
  }
  if (state.ocrController) state.ocrController.abort();
  state.ocrController = new AbortController();
  const sequence = ++state.ocrSequence;
  const inputRevision = state.inputRevision;
  const requestId = `ocr-${Date.now()}-${sequence}`;

  invalidateConfirmation();
  dom.recognizeButton.disabled = true;
  dom.recognizeButton.classList.add("is-loading");
  $("strong", dom.recognizeButton).textContent = "Читаю формулу…";
  dom.ocrButtonHint.textContent = "это может занять несколько секунд";

  try {
    const image = dom.writeCanvas.toDataURL("image/png").split(",")[1];
    const result = await postJSON(
      "/api/recognize",
      { request_id: requestId, image_base64: image },
      state.ocrController.signal,
    );
    if (sequence !== state.ocrSequence || inputRevision !== state.inputRevision || result.request_id !== requestId) return;

    dom.formulaInput.value = result.candidate;
    state.formulaRevision += 1;
    updateSourceBadge("ocr");
    const template = inferTemplate(result.candidate);
    if (template) selectTemplateVisual(template);
    updateParameterCards(result.parameters || TEMPLATES[template]?.parameters || []);
    updateEquationLabels();
    setProgress(2);
    showToast(`Формула распознана за ${(result.latency_ms / 1000).toFixed(1).replace(".", ",")} с. Проверьте её перед построением.`);
    dom.formulaInput.focus();
    dom.formulaInput.select();
  } catch (error) {
    if (error.name !== "AbortError") {
      const suffix = error.code === "OLLAMA_UNAVAILABLE" ? " Можно выбрать пример или ввести формулу вручную." : "";
      showToast(`${error.message}${suffix}`, "error", 6500);
      setProgress(2);
    }
  } finally {
    if (sequence === state.ocrSequence) {
      dom.recognizeButton.classList.remove("is-loading");
      $("strong", dom.recognizeButton).textContent = "Распознать запись";
      dom.ocrButtonHint.textContent = state.ocrReady
        ? "локальная модель · данные не покидают компьютер"
        : "ручной ввод доступен без модели";
      dom.recognizeButton.disabled = state.strokes.length === 0;
    }
  }
}


function applyTemplate(id) {
  const template = TEMPLATES[id];
  if (!template) return;
  dom.formulaInput.value = template.formula;
  dom.formulaInput.blur();
  selectTemplateVisual(id);
  updateSourceBadge("template");
  resetCoefficientValues();
  updateParameterCards(template.parameters);
  state.formulaRevision += 1;
  invalidateConfirmation({ advance: false });
  setProgress(2);
}


async function requestPlot({ isConfirmation = false, quiet = false } = {}) {
  const formula = dom.formulaInput.value.trim();
  if (!formula) {
    showToast("Введите формулу перед построением.", "error");
    return;
  }

  if (state.plotController) state.plotController.abort();
  state.plotController = new AbortController();
  const sequence = ++state.plotSequence;
  const revision = state.formulaRevision;
  const requestId = `plot-${Date.now()}-${sequence}`;

  dom.confirmButton.disabled = true;
  $("span", dom.confirmButton).textContent = isConfirmation ? "Проверяю формулу…" : "Пересчитываю…";

  try {
    const result = await postJSON(
      "/api/plot",
      {
        request_id: requestId,
        formula,
        confirmed: true,
        coefficients: coefficients(),
      },
      state.plotController.signal,
    );
    if (sequence !== state.plotSequence || revision !== state.formulaRevision || result.request_id !== requestId) return;

    dom.formulaInput.value = result.formula;
    state.points = result.points;
    state.graphResponse = result;
    updateParameterCards(result.parameters || []);
    setConfirmed(true);
    dom.graphEmpty.classList.add("is-hidden");
    dom.pointStat.textContent = `${result.point_count} точка`;
    dom.gapStat.textContent = result.domain_gaps
      ? `Разрывов: ${result.domain_gaps}`
      : "Разрывов нет";
    updateEquationLabels();
    drawGraph();
    setProgress(3);
    showScreen("graph");
    if (!quiet) showToast(result.domain_gaps ? "График построен. Разрыв области определения показан пропуском." : "График построен — попробуйте изменить коэффициенты.");
  } catch (error) {
    if (error.name !== "AbortError") {
      setConfirmed(false);
      setGraphEmpty("Формула требует исправления", "Проверьте запись и подтвердите ещё раз");
      showToast(error.message, "error", 5600);
      setProgress(2);
    }
  } finally {
    if (sequence === state.plotSequence) {
      dom.confirmButton.disabled = false;
      $("span", dom.confirmButton).textContent = state.confirmed ? "Формула подтверждена" : "Подтвердить и показать график";
    }
  }
}


function schedulePlot() {
  if (!state.confirmed) return;
  clearTimeout(state.plotTimer);
  state.plotTimer = window.setTimeout(() => requestPlot({ quiet: true }), 85);
}


function resizeGraphCanvas() {
  const rect = dom.graphCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (dom.graphCanvas.width !== pixelWidth || dom.graphCanvas.height !== pixelHeight) {
    dom.graphCanvas.width = pixelWidth;
    dom.graphCanvas.height = pixelHeight;
  }
  state.graphSize = { width: rect.width, height: rect.height, dpr };
  graphContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGraph();
}


function drawGraph() {
  const { width, height, dpr = 1 } = state.graphSize;
  if (!width || !height) return;
  graphContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  graphContext.clearRect(0, 0, width, height);

  const margin = {
    left: Math.max(35, width * 0.055),
    right: 15,
    top: 14,
    bottom: Math.max(27, height * 0.07),
  };
  const plot = {
    left: margin.left,
    top: margin.top,
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom,
  };
  state.plotArea = plot;
  const mapX = (x) => plot.left + ((x + 10) / 20) * plot.width;
  const mapY = (y) => plot.top + ((10 - y) / 20) * plot.height;

  graphContext.fillStyle = "#fbfcfa";
  graphContext.fillRect(0, 0, width, height);

  graphContext.save();
  graphContext.beginPath();
  graphContext.rect(plot.left, plot.top, plot.width, plot.height);
  graphContext.clip();

  for (let value = -10; value <= 10; value += 1) {
    const major = value % 5 === 0;
    graphContext.beginPath();
    graphContext.strokeStyle = major ? "#d9e0db" : "#edf0ed";
    graphContext.lineWidth = major ? 1 : 0.7;
    graphContext.moveTo(mapX(value), plot.top);
    graphContext.lineTo(mapX(value), plot.top + plot.height);
    graphContext.moveTo(plot.left, mapY(value));
    graphContext.lineTo(plot.left + plot.width, mapY(value));
    graphContext.stroke();
  }

  graphContext.strokeStyle = "#809087";
  graphContext.lineWidth = 1.15;
  graphContext.beginPath();
  graphContext.moveTo(plot.left, mapY(0));
  graphContext.lineTo(plot.left + plot.width, mapY(0));
  graphContext.moveTo(mapX(0), plot.top);
  graphContext.lineTo(mapX(0), plot.top + plot.height);
  graphContext.stroke();

  if (state.points.length) {
    graphContext.beginPath();
    graphContext.lineWidth = Math.max(2, width / 420);
    graphContext.strokeStyle = "#166044";
    graphContext.lineCap = "round";
    graphContext.lineJoin = "round";
    let drawing = false;
    let previousY = null;
    for (const [x, y] of state.points) {
      const visible = y !== null && y >= -10.3 && y <= 10.3;
      const discontinuity = previousY !== null && y !== null && Math.abs(y - previousY) > 12;
      if (!visible || discontinuity) {
        drawing = false;
        previousY = y;
        continue;
      }
      const px = mapX(x);
      const py = mapY(y);
      if (!drawing) graphContext.moveTo(px, py);
      else graphContext.lineTo(px, py);
      drawing = true;
      previousY = y;
    }
    graphContext.stroke();

    if (state.hoverIndex !== null) {
      const point = state.points[state.hoverIndex];
      if (point && point[1] !== null && point[1] >= -10 && point[1] <= 10) {
        const [x, y] = point;
        graphContext.beginPath();
        graphContext.fillStyle = "#d8ff68";
        graphContext.strokeStyle = "#123a2d";
        graphContext.lineWidth = 2;
        graphContext.arc(mapX(x), mapY(y), 4.5, 0, Math.PI * 2);
        graphContext.fill();
        graphContext.stroke();
      }
    }
  }
  graphContext.restore();

  graphContext.fillStyle = "#8c9992";
  graphContext.font = `${Math.max(8, width / 105)}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
  graphContext.textAlign = "center";
  graphContext.textBaseline = "top";
  for (const value of [-10, -5, 0, 5, 10]) {
    graphContext.fillText(String(value).replace("-", "−"), mapX(value), plot.top + plot.height + 7);
  }
  graphContext.textAlign = "right";
  graphContext.textBaseline = "middle";
  for (const value of [-10, -5, 5, 10]) {
    graphContext.fillText(String(value).replace("-", "−"), plot.left - 7, mapY(value));
  }
  graphContext.fillStyle = "#53665c";
  graphContext.font = `italic ${Math.max(10, width / 82)}px Georgia, serif`;
  graphContext.textAlign = "right";
  graphContext.fillText("x", plot.left + plot.width - 4, mapY(0) - 10);
  graphContext.textAlign = "left";
  graphContext.fillText("y", mapX(0) + 7, plot.top + 4);
}


function graphPointerMove(event) {
  if (!state.points.length || !state.plotArea) return;
  const rect = dom.graphCanvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  const plot = state.plotArea;
  if (localX < plot.left || localX > plot.left + plot.width || localY < plot.top || localY > plot.top + plot.height) {
    hideGraphTooltip();
    return;
  }
  const x = -10 + ((localX - plot.left) / plot.width) * 20;
  const index = Math.max(0, Math.min(state.points.length - 1, Math.round((x + 10) / 0.05)));
  state.hoverIndex = index;
  const [pointX, pointY] = state.points[index];
  dom.graphTooltip.textContent = pointY === null
    ? `x = ${formatNumber(pointX)} · не определено`
    : `x = ${formatNumber(pointX)} · y = ${formatNumber(Math.round(pointY * 100) / 100)}`;
  dom.graphTooltip.style.left = `${localX}px`;
  dom.graphTooltip.style.top = `${localY}px`;
  dom.graphTooltip.classList.add("is-visible");
  drawGraph();
}


function hideGraphTooltip() {
  state.hoverIndex = null;
  dom.graphTooltip.classList.remove("is-visible");
  drawGraph();
}


async function checkSystem() {
  dom.systemPill.className = "system-pill";
  try {
    const healthResponse = await fetch("/api/health", { cache: "no-store" });
    if (!healthResponse.ok) throw new Error("health");
    const ocrResponse = await fetch("/api/ocr-status", { cache: "no-store" });
    if (!ocrResponse.ok) throw new Error("ocr-status");
    const ocr = await ocrResponse.json();
    state.ocrReady = Boolean(ocr.available && ocr.model_ready);
    if (state.ocrReady) {
      dom.systemPill.classList.add("is-ready");
      dom.systemText.textContent = "OCR готов";
      dom.ocrButtonHint.textContent = "локальная модель · данные не покидают компьютер";
    } else {
      dom.systemPill.classList.add("is-partial");
      dom.systemText.textContent = ocr.available ? "Нужна OCR-модель" : "Ручной режим";
      dom.ocrButtonHint.textContent = ocr.available ? "загрузите модель для распознавания" : "ручной ввод доступен без модели";
    }
  } catch {
    dom.systemPill.classList.add("is-error");
    dom.systemText.textContent = "Сервер недоступен";
    dom.ocrButtonHint.textContent = "проверьте локальный сервер";
  }
}


function resetSession() {
  if (state.ocrController) state.ocrController.abort();
  if (state.plotController) state.plotController.abort();
  state.ocrSequence += 1;
  state.plotSequence += 1;
  state.formulaRevision += 1;
  clearWriting(false);
  dom.formulaInput.value = TEMPLATES.linear.formula;
  selectTemplateVisual("linear");
  updateSourceBadge("template");
  resetCoefficientValues();
  updateParameterCards(TEMPLATES.linear.parameters);
  setConfirmed(false);
  clearGraph();
  setProgress(1);
  showScreen("input");
  showToast("Доска очищена. Можно начать новый эксперимент.");
}


dom.writeCanvas.addEventListener("pointerdown", beginStroke);
dom.writeCanvas.addEventListener("pointermove", extendStroke);
dom.writeCanvas.addEventListener("pointerup", endStroke);
dom.writeCanvas.addEventListener("pointercancel", endStroke);
dom.writeCanvas.addEventListener("lostpointercapture", endStroke);
dom.undoButton.addEventListener("click", undoStroke);
dom.clearButton.addEventListener("click", () => clearWriting(true));
dom.recognizeButton.addEventListener("click", recognizeWriting);

dom.templateList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-template]");
  if (button) applyTemplate(button.dataset.template);
});

dom.formulaInput.addEventListener("input", () => {
  updateSourceBadge("manual");
  const template = inferTemplate(dom.formulaInput.value);
  if (template) {
    selectTemplateVisual(template);
    updateParameterCards(TEMPLATES[template].parameters);
  } else {
    $$(".template-card", dom.templateList).forEach((button) => button.classList.remove("is-selected"));
    updateParameterCards(["a", "b", "c"].filter((name) => new RegExp(`\\b${name}\\b`).test(dom.formulaInput.value)));
  }
  state.formulaRevision += 1;
  invalidateConfirmation({ advance: false });
  updateEquationLabels();
  setProgress(2);
});

dom.confirmButton.addEventListener("click", () => requestPlot({ isConfirmation: true }));

for (const input of Object.values(coefficientInputs)) {
  input.addEventListener("input", () => {
    updateCoefficientUI();
    schedulePlot();
  });
}

dom.resetCoefficients.addEventListener("click", () => {
  resetCoefficientValues();
  schedulePlot();
});

dom.graphCanvas.addEventListener("pointermove", graphPointerMove);
dom.graphCanvas.addEventListener("pointerleave", hideGraphTooltip);
dom.backButton.addEventListener("click", () => {
  showScreen("input");
  setProgress(1);
  window.setTimeout(() => dom.formulaInput.focus(), 120);
});
dom.newSessionButton.addEventListener("click", resetSession);
dom.toastClose.addEventListener("click", () => dom.toast.classList.remove("is-visible"));

dom.helpButton.addEventListener("click", () => {
  if (typeof dom.helpDialog.showModal === "function") dom.helpDialog.showModal();
});

dom.fullscreenButton.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    showToast("Полноэкранный режим недоступен в этом браузере.", "error");
  }
});

document.addEventListener("fullscreenchange", () => {
  dom.fullscreenButton.setAttribute("aria-label", document.fullscreenElement ? "Выйти из полноэкранного режима" : "Открыть на весь экран");
});

document.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "z" && document.activeElement !== dom.formulaInput) {
    event.preventDefault();
    undoStroke();
  }
  if (modifier && event.key === "Enter") {
    event.preventDefault();
    requestPlot({ isConfirmation: true });
  }
});

const resizeObserver = new ResizeObserver(resizeGraphCanvas);
resizeObserver.observe(dom.graphWrap);

renderWriting();
updateCoefficientUI();
updateParameterCards(TEMPLATES.linear.parameters);
setProgress(1);
showScreen("input");
resizeGraphCanvas();
checkSystem();
