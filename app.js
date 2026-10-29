"use strict";

const APP_VERSION = "1";
const STORE = "capcheck:v" + APP_VERSION + ":";
const ANSWERS = [["yes", "Yes, hallucinated"], ["no", "No"], ["cant", "Can't tell"]];
const ANSWER_LABEL = Object.fromEntries(ANSWERS);

let DATA = null;      // {version, sets: {A: [item...]}}
let PRACTICE = [];    // [item with targets[].answer/why]
let S = null;         // annotator state, saved to localStorage
let itemShownAt = 0;  // performance.now() when the current item was shown

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(k));
  return e;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// caption markdown: only **bold** occurs; drop unpaired markers
function richText(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*\*/g, "");
}

// ---------------------------------------------------------------- storage (per-browser only)
function keyFor(name, set) { return STORE + set + ":" + name.trim().toLowerCase(); }
function save() {
  try {
    localStorage.setItem(keyFor(S.name, S.set), JSON.stringify(S));
    localStorage.setItem(STORE + "last", JSON.stringify({ name: S.name, set: S.set }));
  } catch (e) { /* storage unavailable: answers live only in this tab until downloaded */ }
}
function loadState(name, set) {
  try { const v = localStorage.getItem(keyFor(name, set)); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function lastSession() {
  try { return JSON.parse(localStorage.getItem(STORE + "last") || "null"); } catch (e) { return null; }
}

// ---------------------------------------------------------------- seeded order per annotator
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, seed) {
  const rnd = mulberry32(seed), a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------- helpers
const setItems = () => DATA.sets[S.set];
const itemById = id => setItems().find(it => it.id === id) || PRACTICE.find(it => it.id === id);
const currentItem = () => S.phase === "practice" ? PRACTICE[S.pIdx] : itemById(S.order[S.idx]);
function rec(id) {
  if (!S.answers[id]) S.answers[id] = { t: {}, c: "", ms: 0, at: "" };
  return S.answers[id];
}
function itemComplete(item) {
  const r = S.answers[item.id];
  return !!r && item.targets.every(t => {
    const a = r.t[t.n];
    return a && a.a && (a.a !== "yes" || (a.w && a.w.length));
  });
}
function flushTime() {
  if (!S || !itemShownAt || S.phase === "done" || S.phase === "intro") return;
  const it = currentItem();
  if (it) rec(it.id).ms += Math.round(performance.now() - itemShownAt);
  itemShownAt = performance.now();
}
function tokens(text) { return text.split(/\s+/).filter(Boolean); }
function wrongWords(text, idx) {
  const toks = tokens(text), sorted = [...idx].sort((a, b) => a - b), parts = [];
  let run = [];
  for (const i of sorted) {
    if (run.length && i !== run[run.length - 1] + 1) { parts.push(run); run = []; }
    run.push(i);
  }
  if (run.length) parts.push(run);
  return parts.map(p => p.map(i => toks[i]).join(" ")).join(" … ");
}

// ---------------------------------------------------------------- chrome
function setChrome() {
  const started = S && S.phase !== "intro";
  $("#btn-rules").hidden = !started;
  $("#btn-save").hidden = !started;
  const prog = $("#progress");
  if (!S || S.phase === "intro") { $("#status").textContent = ""; prog.hidden = true; return; }
  const n = setItems().length;
  const done = S.order.filter(id => itemComplete(itemById(id))).length;
  prog.hidden = false;
  $("#progress-bar").style.width = (100 * done / n) + "%";
  if (S.phase === "practice") $("#status").textContent = `${S.name} · Set ${S.set} · Practice ${S.pIdx + 1} of ${PRACTICE.length}`;
  else if (S.phase === "main") $("#status").textContent = `${S.name} · Set ${S.set} · Item ${S.idx + 1} of ${n} · ${done} done`;
  else $("#status").textContent = `${S.name} · Set ${S.set} · ${done} of ${n} done`;
}

function rulesNode() { return $("#rules-tpl").content.cloneNode(true); }

// ---------------------------------------------------------------- welcome
function renderWelcome() {
  S = null;
  setChrome();
  const urlSet = (new URLSearchParams(location.search).get("set") || "").toUpperCase();
  const sets = Object.keys(DATA.sets);
  const fixedSet = sets.includes(urlSet) ? urlSet : null;
  const last = lastSession();
  const n = fixedSet ? DATA.sets[fixedSet].length : DATA.sets[sets[0]].length;

  const nameIn = el("input", { type: "text", id: "name", autocomplete: "name", placeholder: "First and last name" });
  const setIn = fixedSet
    ? el("input", { type: "text", id: "set", value: "Set " + fixedSet, disabled: true })
    : el("select", { id: "set" }, el("option", { value: "" }, "Choose your set"), sets.map(s => el("option", { value: s }, "Set " + s)));
  const err = el("div", { class: "error", role: "alert" });

  function start() {
    const name = nameIn.value.trim();
    const set = fixedSet || setIn.value;
    if (!name) { err.textContent = "Please enter your name."; nameIn.focus(); return; }
    if (!set) { err.textContent = "Please choose the set you were given."; return; }
    begin(name, set);
  }
  nameIn.addEventListener("keydown", e => { if (e.key === "Enter") start(); });

  let resume = null;
  if (last && DATA.sets[last.set] && (!fixedSet || fixedSet === last.set) && loadState(last.name, last.set)) {
    resume = el("div", { class: "card" },
      el("p", {}, `Welcome back, ${last.name}. Your answers for Set ${last.set} are saved in this browser.`),
      el("button", { class: "primary", type: "button", onclick: () => begin(last.name, last.set) }, "Continue where you left off"));
  }

  const app = $("#app");
  app.replaceChildren(el("div", { class: "page" },
    el("h1", {}, "Is the description right about the photo?"),
    el("p", { class: "lead" },
      `You will see ${n} photos, each with a description written by an AI. For a few highlighted sentences per photo, ` +
      "you decide whether the sentence is hallucinated. It takes about an hour. Your answers are saved in this browser " +
      "as you go, so you can stop and come back later on the same computer."),
    resume,
    el("div", { class: "card" }, el("h2", {}, "How to judge"), rulesNode()),
    el("div", { class: "card" },
      el("h2", {}, "Start"),
      el("p", { class: "note" }, "First you do 3 practice items with feedback. Please use a laptop or desktop."),
      el("div", { class: "form-row" },
        el("label", {}, "Your name", nameIn),
        el("label", {}, "Set", setIn),
        el("button", { class: "primary", type: "button", onclick: start }, "Start")),
      err)));
  window.scrollTo(0, 0);
}

function begin(name, set) {
  S = loadState(name, set);
  if (!S) {
    S = {
      name, set, data_version: DATA.version, app_version: APP_VERSION, started: new Date().toISOString(),
      order: shuffled(DATA.sets[set].map(it => it.id), hashStr(name.toLowerCase() + "|" + set)),
      phase: "practice", pIdx: 0, idx: 0, checked: {}, answers: {},
    };
    save();
  }
  route();
}

function route() {
  setChrome();
  if (S.phase === "practice" || S.phase === "main") renderItem();
  else if (S.phase === "intro") renderStudyIntro();
  else renderDone();
}

// ---------------------------------------------------------------- item view
function renderItem() {
  const item = currentItem();
  const practice = S.phase === "practice";
  const r = rec(item.id);
  const checked = practice && S.checked[item.id];

  const img = el("img", { src: item.img, alt: "Photo for this item", onclick: () => openZoom(item.img) });
  const media = el("div", { class: "media" }, img, el("div", { class: "hint" }, "Click the photo to enlarge it."));

  const caption = el("div", { class: "caption" });
  for (const [text, n] of item.segs) {
    if (n) {
      const m = el("mark", { class: "t", "data-n": n });
      m.append(el("span", { class: "badge", "aria-hidden": "true" }, String(n)));
      m.insertAdjacentHTML("beforeend", richText(text));
      caption.append(m);
    } else {
      caption.insertAdjacentHTML("beforeend", richText(text));
    }
  }

  const err = el("div", { class: "error", role: "alert" });
  const questions = el("div", { class: "questions" });
  for (const t of item.targets) questions.append(renderQuestion(item, t, r, checked, err));

  const comment = el("textarea", { placeholder: "Anything unclear about this item? (optional)" });
  comment.value = r.c || "";
  comment.addEventListener("input", () => { r.c = comment.value; save(); });

  let nextLabel = "Next";
  if (practice) nextLabel = checked ? (S.pIdx + 1 < PRACTICE.length ? "Next practice item" : "Continue") : "Check my answers";
  else if (S.idx + 1 === S.order.length) nextLabel = "Finish";
  const back = el("button", { type: "button", onclick: goBack, disabled: practice ? S.pIdx === 0 : false }, "Back");
  const next = el("button", { type: "button", class: "primary", id: "btn-next", onclick: () => goNext(err) }, nextLabel);

  $("#app").replaceChildren(el("section", { class: "item" },
    media,
    el("div", { class: "text" },
      practice ? el("span", { class: "practice-tag" }, `Practice ${S.pIdx + 1} of ${PRACTICE.length}`) : null,
      el("div", { class: "caption-label" }, "Description"),
      caption,
      questions,
      el("label", { class: "comment" }, "Comment", comment),
      el("div", { class: "nav" }, back, err, next),
      el("div", { class: "keys" }, "Keys: ← back · → next"))));
  itemShownAt = performance.now();
  window.scrollTo(0, 0);
}

function renderQuestion(item, t, r, checked, err) {
  const a = r.t[t.n] || (r.t[t.n] = { a: "", w: [] });
  const box = el("div", { class: "q", "data-n": t.n });
  const head = el("div", { class: "q-head" }, el("span", { class: "badge" }, String(t.n)), `Is sentence ${t.n} hallucinated?`);
  const words = el("div", { class: "words", hidden: a.a !== "yes" });
  const toks = el("div", { class: "tokens" });
  tokens(t.text).forEach((w, i) => {
    const tok = el("span", { class: "tok" + (a.w.includes(i) ? " sel" : ""), role: "button", tabindex: "0", "aria-pressed": String(a.w.includes(i)) }, w);
    const toggle = () => {
      if (checked) return;
      const k = a.w.indexOf(i);
      if (k >= 0) a.w.splice(k, 1); else a.w.push(i);
      tok.classList.toggle("sel", k < 0);
      tok.setAttribute("aria-pressed", String(k < 0));
      r.at = new Date().toISOString(); err.textContent = ""; save(); setChrome();
    };
    tok.addEventListener("click", toggle);
    tok.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    toks.append(tok, " ");
  });
  words.append(el("div", { class: "words-label" }, "Click the word(s) that are wrong:"), toks);

  const choices = el("div", { class: "choices", role: "group", "aria-label": `Sentence ${t.n}` });
  for (const [val, label] of ANSWERS) {
    const b = el("button", { type: "button", "aria-pressed": String(a.a === val), disabled: !!checked }, label);
    b.addEventListener("click", () => {
      a.a = val;
      if (val !== "yes") a.w = [];
      for (const x of choices.children) x.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-pressed", "true");
      words.hidden = val !== "yes";
      if (val !== "yes") toks.querySelectorAll(".tok.sel").forEach(x => { x.classList.remove("sel"); x.setAttribute("aria-pressed", "false"); });
      r.at = new Date().toISOString(); err.textContent = ""; save(); setChrome();
    });
    choices.append(b);
  }

  box.append(head, choices, words);
  if (checked) box.append(feedback(t, a));
  const mark = () => document.querySelector(`mark.t[data-n="${t.n}"]`);
  box.addEventListener("mouseenter", () => mark() && mark().classList.add("active"));
  box.addEventListener("mouseleave", () => mark() && mark().classList.remove("active"));
  box.addEventListener("focusin", () => mark() && mark().classList.add("active"));
  box.addEventListener("focusout", () => mark() && mark().classList.remove("active"));
  return box;
}

function feedback(t, a) {
  const right = a.a === t.answer;
  const expected = ANSWER_LABEL[t.answer] + (t.wrong ? ` (wrong words: “${t.wrong}”)` : "");
  return el("div", { class: "feedback " + (right ? "right" : "off") },
    el("b", {}, right ? "Matches our answer. " : `Our answer: ${expected}. `), t.why);
}

function goNext(err) {
  const item = currentItem();
  if (!itemComplete(item)) {
    const r = S.answers[item.id];
    const missingWords = item.targets.some(t => r && r.t[t.n] && r.t[t.n].a === "yes" && !r.t[t.n].w.length);
    err.textContent = missingWords ? "For each “Yes”, click the wrong word(s)." : "Please answer every highlighted sentence.";
    return;
  }
  flushTime();
  if (S.phase === "practice") {
    if (!S.checked[item.id]) { S.checked[item.id] = true; save(); renderItem(); return; }
    if (S.pIdx + 1 < PRACTICE.length) S.pIdx++;
    else S.phase = "intro";
  } else if (S.idx + 1 < S.order.length) {
    S.idx++;
  } else {
    S.phase = "done";
  }
  save(); route();
}

function goBack() {
  flushTime();
  if (S.phase === "practice") { if (S.pIdx > 0) S.pIdx--; }
  else if (S.idx > 0) S.idx--;
  else { S.phase = "intro"; }
  save(); route();
}

// ---------------------------------------------------------------- between practice and study, and the end
function renderStudyIntro() {
  $("#app").replaceChildren(el("div", { class: "page" },
    el("h1", {}, "Practice done"),
    el("div", { class: "card" },
      el("p", {}, `Now the ${S.order.length} study items. There is no feedback from here on. Judge each sentence on its own; ` +
        "some items have no hallucinated sentence and some have several."),
      el("p", { class: "note" }, "The rules are always available from the Rules button at the top. " +
        "Your answers are saved in this browser as you go."),
      el("div", { class: "big-actions" },
        el("button", { type: "button", onclick: () => { S.phase = "practice"; S.pIdx = PRACTICE.length - 1; save(); route(); } }, "Back to practice"),
        el("button", { type: "button", class: "primary", onclick: () => { S.phase = "main"; save(); route(); } }, "Start the study")))));
  window.scrollTo(0, 0);
}

function renderDone() {
  const n = S.order.length;
  const done = S.order.filter(id => itemComplete(itemById(id))).length;
  const msg = el("div", { class: "note", role: "status" });
  $("#app").replaceChildren(el("div", { class: "page" },
    el("h1", {}, done === n ? "All done. Thank you!" : `${done} of ${n} items answered`),
    el("div", { class: "card" },
      el("p", { class: "lead" }, "Please download your answers and send the file to the person who gave you this link."),
      el("div", { class: "big-actions" },
        el("button", { type: "button", class: "primary", onclick: downloadCsv }, "Download answers (CSV)"),
        el("button", { type: "button", onclick: () => copyCsv(msg) }, "Copy answers as text")),
      msg,
      el("p", { class: "note" }, "If the download does not work, use “Copy answers as text” and paste it into an email or chat.")),
    el("div", { class: "big-actions" },
      el("button", { type: "button", onclick: () => { S.phase = "main"; S.idx = n - 1; save(); route(); } }, "Review my answers"))));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- export
const COLUMNS = ["annotator", "set", "phase", "position", "item_id", "image", "sentence_no", "answer",
  "wrong_words", "wrong_word_idx", "sentence", "item_comment", "item_seconds", "answered_at", "data_version", "app_version"];

function csvCell(v) {
  v = v == null ? "" : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function buildCsv() {
  flushTime(); save();
  const rows = [COLUMNS];
  const add = (phase, pos, item) => {
    const r = S.answers[item.id] || { t: {}, c: "", ms: 0, at: "" };
    for (const t of item.targets) {
      const a = r.t[t.n] || { a: "", w: [] };
      const w = [...(a.w || [])].sort((x, y) => x - y);
      rows.push([S.name, S.set, phase, pos, item.id, item.img.replace(/^img\//, ""), t.n, a.a,
        w.length ? wrongWords(t.text, w) : "", w.join(" "), t.text, r.c || "", Math.round((r.ms || 0) / 1000),
        r.at || "", DATA.version, APP_VERSION]);
    }
  };
  PRACTICE.forEach((it, i) => add("practice", i + 1, it));
  S.order.forEach((id, i) => add("main", i + 1, itemById(id)));
  return rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function downloadCsv() {
  const slug = S.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "anon";
  const blob = new Blob(["﻿" + buildCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `capcheck_set${S.set}_${slug}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyCsv(msg) {
  const text = buildCsv();
  try { await navigator.clipboard.writeText(text); msg.textContent = "Copied. Paste it into an email or chat."; }
  catch (e) {
    const ta = el("textarea", { readonly: true, rows: 8 }); ta.value = text;
    msg.replaceChildren("Copy the text below:", ta); ta.select();
  }
}

// ---------------------------------------------------------------- overlays, keys
function openZoom(src) { const z = $("#zoom"); $("img", z).src = src; z.hidden = false; }
function closeOverlays() { $("#zoom").hidden = true; $("#rules-panel").hidden = true; }

function wire() {
  $("#zoom").addEventListener("click", () => { $("#zoom").hidden = true; });
  $("#btn-rules").addEventListener("click", () => {
    const p = $("#rules-panel");
    if (!$(".rules-panel-body", p).childElementCount) $(".rules-panel-body", p).append(rulesNode());
    p.hidden = !p.hidden;
  });
  $("#btn-rules-close").addEventListener("click", () => { $("#rules-panel").hidden = true; });
  $("#btn-save").addEventListener("click", downloadCsv);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeOverlays(); return; }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!S || (S.phase !== "main" && S.phase !== "practice")) return;
    if (e.key === "ArrowRight") { const b = $("#btn-next"); if (b) b.click(); }
    else if (e.key === "ArrowLeft") { if (S.phase === "main" || S.pIdx > 0) goBack(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { flushTime(); itemShownAt = 0; if (S) save(); }
    else if (S && (S.phase === "main" || S.phase === "practice")) itemShownAt = performance.now();
  });
  window.addEventListener("pagehide", () => { flushTime(); if (S) save(); });
}

async function init() {
  wire();
  try {
    const [items, practice] = await Promise.all([
      fetch("data/items.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch("data/practice.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);
    DATA = items; PRACTICE = practice;
  } catch (e) {
    $("#app").replaceChildren(el("p", { class: "loading" }, "Could not load the study data. Please reload the page."));
    return;
  }
  renderWelcome();
}

init();
