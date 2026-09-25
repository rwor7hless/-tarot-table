// Стол гадалки — Telegram Mini App for TarotAI. Static page: no server of its own.
// The user shuffles, pulls cards from a fan and turns them over; the pulled cards go back to the bot
// with Telegram.WebApp.sendData, and the bot writes the interpretation in the chat (bot/handlers/table.py).
// sendData works only when the page is opened from the bot's keyboard button «Стол гадалки».
import { Motes, Sparks, hexToRgb } from "./fx.js?v=5";
import { isOn, setOn, sound, unlock } from "./sound.js?v=5";

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg && tg.platform && tg.platform !== "unknown");
const params = new URLSearchParams(location.search);
const unlocked = (params.get("tier") || "free") !== "free"; // decoration only: the bot re-checks access
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches; // switches off ambient motion only

const REVERSED_P = 0.35; // same as the bot's REVERSED_PROBABILITY default
const FAN_SIZE = { day: 15, three: 17, five: 19, celtic: 22 };
const ACCENT = { spirit: "#9B7BFF", advisor: "#4FB3A9", friend: "#E68AB8" };
// Positions in card units: [x, y, crossing]. Same arrangement as the bot's spread pictures (bot/images.py).
const LAYOUT = {
  day: [[0, 0]],
  three: [[-1, 0], [0, 0], [1, 0]],
  five: [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]],
  celtic: [[0, 0], [0, 0, 1], [0, 1], [-1.2, 0], [0, -1], [1.2, 0], [2.6, 1.5], [2.6, 0.5], [2.6, -0.5], [2.6, -1.5]],
};
const FAN_ZONE = 160;     // px at the bottom of the table taken by the fan while picking
const FAN_CARD_W = 64;
const FAN_TOP = 34;
const FAN_ORIGIN = 3.4;   // transform-origin of fan cards, in card heights below their top edge
const CARD_RATIO = 600 / 350;
const DECK_N = 14;
const GOLD = [242, 217, 138];
const PAD = 14;

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const app = $("app"), table = $("table"), deckEl = $("deck"), slotsEl = $("slots"), fanEl = $("fan");
const hint = $("hint"), note = $("note"), drawnEl = $("drawn"), bar = $("bar"), primaryBtn = $("primary");
const linesEl = $("lines"), soundBtn = $("sound");

let data;               // data.json: cards, spreads, personas
let cardsById;
let spread;             // chosen spread
let persona = params.get("persona");
let fanCards = [];      // [{card, el, angle}] still in the fan
let picked = [];        // [{id, r, el}] in position order
let slotEls = [];       // [{box, label, num}]
let fittedHeight = null; // table height after fitTable(); clientHeight lags behind while the height animates
let hover = null;       // the fan card under the finger
let scrubbing = false;

const motes = new Motes($("motes"));
const sparks = new Sparks($("sparks"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const stage = () => app.dataset.stage;
const accentRgb = () => hexToRgb(ACCENT[persona] || ACCENT.spirit);
const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; };

// ---------- randomness: crypto, like the bot's secrets.SystemRandom ----------

function randInt(n) {
  const buf = new Uint32Array(1), limit = Math.floor(2 ** 32 / n) * n;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}
const chance = (p) => randInt(1_000_000) < p * 1_000_000;

function shuffled(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- errors: a failing Telegram call must never stop the cards ----------

function safely(fn) {
  try { fn(); } catch (e) { report(e); }
}

function report(e) {
  console.error(e);
  note.textContent = `Ошибка на столе: ${e?.message || e}. Пришли этот текст в чат с ботом, чтобы её исправили.`;
  note.hidden = false;
}
addEventListener("error", (e) => report(e.error || e.message));
addEventListener("unhandledrejection", (e) => report(e.reason));

// ---------- Telegram glue ----------

const haptic = {
  select: () => safely(() => tg?.HapticFeedback?.selectionChanged()),
  tap: () => safely(() => tg?.HapticFeedback?.impactOccurred("light")),
  flip: () => safely(() => tg?.HapticFeedback?.impactOccurred("medium")),
  heavy: () => safely(() => tg?.HapticFeedback?.impactOccurred("heavy")),
  done: () => safely(() => tg?.HapticFeedback?.notificationOccurred("success")),
};

// One primary action per stage: Telegram's own button inside Telegram, our button in a browser.
const primary = {
  handler: null,
  set(text, handler, { enabled = true, visible = true } = {}) {
    this.handler = enabled ? handler : null;
    if (inTelegram) {
      if (!visible) { tg.MainButton.hide(); return; } // Telegram throws on an empty button text
      tg.MainButton.setParams({ text, color: "#D8B45A", text_color: "#0E0B1F", is_active: enabled, is_visible: true });
      return;
    }
    bar.hidden = !visible;
    primaryBtn.textContent = text;
    primaryBtn.disabled = !enabled;
  },
  hide() { this.set("", null, { visible: false }); },
};

function setupTelegram() {
  if (!inTelegram) return;
  bar.hidden = true;
  safely(() => {
    tg.ready();
    tg.expand();
    tg.setHeaderColor("#0E0B1F");
    tg.setBackgroundColor("#0E0B1F");
    tg.setBottomBarColor?.("#0E0B1F");
    tg.disableVerticalSwipes?.(); // pulling cards must not close the table
  });
  tg.MainButton.onClick(() => primary.handler?.());
  tg.BackButton.onClick(() => reset());
  tg.onEvent("viewportChanged", ({ isStateStable }) => isStateStable && relayout());
}

function setStage(s) {
  app.dataset.stage = s;
  if (inTelegram) safely(() => {
    if (s === "setup") { tg.BackButton.hide(); tg.disableClosingConfirmation(); }
    else { tg.BackButton.show(); tg.enableClosingConfirmation(); }
  });
}

function say(text) {
  if (hint.textContent === text && !hint.classList.contains("fade")) return;
  hint.classList.add("fade");
  clearTimeout(say.timer);
  say.timer = setTimeout(() => { hint.textContent = text; hint.classList.remove("fade"); }, 200);
}

// ---------- setup screen ----------

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const cardsWord = (n) => `${n} ${plural(n, "карта", "карты", "карт")}`;

function option(group, value, title, sub, icon, { checked = false, locked = false } = {}) {
  const label = document.createElement("label");
  label.className = "opt" + (locked ? " locked" : "");
  label.innerHTML = `<input type="radio" name="${group}" value="${value}"><img src="icons/${icon}.svg" alt="">
    <span class="name"></span>${sub ? '<span class="sub"></span>' : ""}`;
  label.querySelector(".name").textContent = title;
  if (sub) label.querySelector(".sub").textContent = sub;
  const input = label.querySelector("input");
  input.checked = checked;
  input.disabled = locked;
  return label;
}

function renderSetup() {
  const SHORT = { day: "Карта дня", three: "Три карты", five: "Пять карт", celtic: "Кельтский крест" };
  const row = document.createElement("div");
  row.className = "spreads-row";
  for (const s of data.spreads) {
    const locked = s.premium && !unlocked;
    row.append(option("spread", s.key, SHORT[s.key] || s.title, locked ? "Премиум" : cardsWord(s.positions.length),
      s.key, { checked: s.key === "three", locked }));
  }
  $("spreads").append(row);
  $("spreads").addEventListener("change", () => { sound.tick(); haptic.select(); previewSpread(); });

  if (!data.personas.some((p) => p.key === persona)) persona = data.personas[0].key;
  const prow = document.createElement("div");
  prow.className = "personas-row";
  for (const p of data.personas) prow.append(option("persona", p.key, p.name, "", p.icon, { checked: p.key === persona }));
  $("personas").append(prow);
  $("personas").addEventListener("change", (e) => {
    persona = e.target.value;
    paintAccent();
    sound.chime(false);
    haptic.select();
    const d = centre(deckEl);
    sparks.burst(d.x, d.y, { count: 26, color: accentRgb(), speed: 150, life: 0.9 });
  });
  paintAccent();

  for (let i = 0; i < DECK_N; i++) {
    const c = makeCard(null);
    c.style.transform = rest(i);
    deckEl.append(c);
  }
}

function paintAccent() {
  const hex = ACCENT[persona] || ACCENT.spirit;
  root.style.setProperty("--accent", hex);
  motes.accent = hexToRgb(hex);
}

function selectedSpread() {
  const key = document.querySelector('input[name="spread"]:checked')?.value;
  return data.spreads.find((s) => s.key === key);
}

function previewSpread() {
  spread = selectedSpread();
  if (spread) buildSlots(); // faint outlines of the positions under the deck
}

// ---------- cards ----------

function makeCard(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = '<div class="card-inner"><div class="face back"></div><div class="face front"></div></div>';
  if (card) {
    el.classList.toggle("reversed", card.r);
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.src = `cards/${card.id}.webp`; // starts loading now: the card is turned over a bit later
    el.querySelector(".front").append(img);
  }
  return el;
}

function describe(i) {
  const pos = spread.positions[i], p = picked[i], card = cardsById[p.id];
  return { pos, card, reversed: p.r, keys: (p.r ? card.rev : card.up).join(", ") };
}

const rest = (i) => `translate(${-i * 0.8}px, ${-i * 0.8}px)`;

// ---------- the ritual: shuffle ----------

function toSetup() {
  setStage("setup");
  say("Выбери расклад и задай вопрос");
  primary.set("Перемешать колоду", shuffle);
}

async function shuffle() {
  if (stage() !== "setup") return;
  spread = selectedSpread();
  if (!spread) return;
  document.activeElement?.blur(); // close the phone keyboard
  fanCards = shuffled(data.cards).slice(0, FAN_SIZE[spread.key] || 17)
    .map((c) => ({ card: { id: c.id, r: chance(REVERSED_P) }, el: null, angle: 0 }));
  picked = [];
  drawnEl.replaceChildren();
  setStage("shuffle");
  say("Тасую колоду…");
  safely(() => primary.hide());
  await riffle();
  await riffle();
  await cutDeck();
  dealFan();
}

async function riffle() {
  const cards = [...deckEl.children];
  const dir = (i) => (i % 2 ? 1 : -1);
  const side = (i) => `translate(${dir(i) * 76}px, ${-i * 0.8 + 4}px) rotate(${dir(i) * 10}deg)`;
  haptic.tap();
  await Promise.all(cards.map((c, i) => c.animate([{ transform: rest(i) }, { transform: side(i) }],
    { duration: 260, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" }).finished));
  const anims = cards.map((c, i) => {
    const delay = i * 30;
    setTimeout(() => { sound.flick(); if (i % 2 === 0) haptic.select(); }, delay + 150);
    return c.animate([
      { transform: side(i) },
      { transform: `translate(${dir(i) * 26}px, ${-i * 0.8 - 26}px) rotate(${dir(i) * 5}deg)`, offset: 0.5 },
      { transform: rest(i) },
    ], { duration: 300, delay, easing: "ease-in-out", fill: "forwards" });
  });
  await Promise.all(anims.map((a) => a.finished));
  cards.forEach((c) => c.getAnimations().forEach((a) => a.cancel()));
}

async function cutDeck() {
  const cards = [...deckEl.children];
  const top = cards.slice(DECK_N / 2);
  sound.whoosh();
  await Promise.all(top.map((c, k) => {
    const i = k + DECK_N / 2;
    return c.animate([
      { transform: rest(i) },
      { transform: `translate(70px, -64px) rotate(8deg)`, offset: 0.45 },
      { transform: `translate(64px, 8px) rotate(3deg)`, offset: 0.72 },
      { transform: rest(i) },
    ], { duration: 640, delay: k * 12, easing: "ease-in-out" }).finished;
  }));
  // square the deck with a knock on the table
  haptic.heavy();
  sound.land();
  const d = centre(deckEl);
  sparks.burst(d.x, d.y + 70, { count: 14, speed: 90, life: 0.6, gravity: 10 });
  await deckEl.animate([{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }],
    { duration: 260, easing: "ease-out" }).finished;
}

// ---------- the fan ----------

function fanTransform(f) {
  return `rotate(${f.angle}deg) translateY(${f === hover ? -28 : 0}px)`;
}

function layoutFan() {
  const n = fanCards.length;
  const spreadDeg = Math.min(100, n * 4.8);
  fanCards.forEach((f, i) => {
    f.angle = n > 1 ? -spreadDeg / 2 + (i * spreadDeg) / (n - 1) : 0;
    f.el.style.transform = fanTransform(f);
  });
}

function dealFan() {
  setStage("pick");
  layoutSlots();
  fanEl.replaceChildren();
  const d = centre(deckEl);
  const fr = fanEl.getBoundingClientRect();
  const restX = fr.left + fr.width / 2, restY = fr.top + FAN_TOP + (FAN_CARD_W * CARD_RATIO) / 2;
  fanCards.forEach((f, i) => {
    const el = makeCard(null);
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `Карта ${i + 1} из веера`);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(f); } });
    f.el = el;
    fanEl.append(el);
  });
  layoutFan();
  fanCards.forEach((f, i) => {
    f.el.animate([
      { transform: `translate(${d.x - restX}px, ${d.y - restY}px) rotate(0deg) scale(1.35)` },
      { transform: fanTransform(f) },
    ], { duration: 560, delay: i * 42, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    setTimeout(() => { sound.flick(); if (i % 3 === 0) haptic.select(); }, i * 42);
  });
  setTimeout(pickHint, 300);
}

function pickHint() {
  const left = spread.positions.length - picked.length;
  say(picked.length ? `Ещё ${cardsWord(left)}` : `Проведи по вееру и отпусти · ${cardsWord(left)}`);
  slotEls.forEach((s, i) => s.box.classList.toggle("next", i === picked.length));
}

// The card under the finger is found by angle around the fan's pivot, not by hit-testing:
// a lifted card would otherwise slip from under the finger and the fan would flicker.
function cardAtPoint(x, y) {
  if (!fanCards.length) return null;
  const fr = fanEl.getBoundingClientRect();
  const px = fr.left + fr.width / 2;
  const py = fr.top + FAN_TOP + FAN_ORIGIN * FAN_CARD_W * CARD_RATIO;
  const a = (Math.atan2(x - px, py - y) * 180) / Math.PI;
  let best = null, bestD = Infinity;
  for (const f of fanCards) {
    const dist = Math.abs(f.angle - a);
    if (dist < bestD) { bestD = dist; best = f; }
  }
  return bestD < 12 ? best : null;
}

function setHover(f) {
  if (f === hover) return;
  const old = hover;
  hover = f;
  if (old?.el) { old.el.classList.remove("hover"); old.el.style.transform = fanTransform(old); }
  if (f?.el) {
    f.el.classList.add("hover");
    f.el.style.transform = fanTransform(f);
    haptic.select();
    sound.tick();
  }
}

fanEl.addEventListener("pointerdown", (e) => {
  if (stage() !== "pick") return;
  e.preventDefault();
  scrubbing = true;
  safely(() => fanEl.setPointerCapture(e.pointerId));
  setHover(cardAtPoint(e.clientX, e.clientY));
});
fanEl.addEventListener("pointermove", (e) => { if (scrubbing) setHover(cardAtPoint(e.clientX, e.clientY)); });
fanEl.addEventListener("pointerup", (e) => {
  if (!scrubbing) return;
  scrubbing = false;
  const f = hover || cardAtPoint(e.clientX, e.clientY);
  setHover(null);
  if (f) pick(f);
});
fanEl.addEventListener("pointercancel", () => { scrubbing = false; setHover(null); });

async function pick(f) {
  if (stage() !== "pick" || picked.length >= spread.positions.length || !fanCards.includes(f)) return;
  haptic.tap();
  sound.flick();
  const i = picked.length;
  const from = centre(f.el);
  f.el.remove();
  fanCards = fanCards.filter((x) => x !== f);
  layoutFan();

  const el = makeCard(f.card);
  const cross = Boolean(LAYOUT[spread.key][i][2]);
  el.dataset.i = i;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${spread.positions[i].name}: открыть карту`);
  if (cross) el.classList.add("cross");
  el.addEventListener("click", () => openCard(i));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCard(i); } });
  picked.push({ ...f.card, el });
  slotEls[i].box.classList.add("filled");
  placeCard(i);
  slotsEl.append(el);

  // fly from the fan to the position along an arc, leaving a trail of sparks
  const to = centre(el);
  const dx = from.x - to.x, dy = from.y - to.y;
  const s = FAN_CARD_W / parseFloat(el.style.width);
  const flight = el.animate([
    { transform: `translate(${dx}px, ${dy}px) rotate(${f.angle}deg) scale(${s})` },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 70}px) rotate(${f.angle * 0.3 + (cross ? 50 : 0) + (dx > 0 ? -8 : 8)}deg) scale(${Math.max(s, 1) * 1.18})`, offset: 0.55 },
    { transform: cross ? "rotate(90deg)" : "none" },
  ], { duration: 680, easing: "cubic-bezier(.35,.1,.25,1)" });
  let flying = true;
  const colour = accentRgb();
  (function trail() {
    if (!flying) return;
    const c = centre(el);
    sparks.trail(c.x, c.y, Math.random() < 0.5 ? GOLD : colour);
    requestAnimationFrame(trail);
  })();
  flight.finished.then(() => {
    flying = false;
    const c = centre(el);
    sparks.burst(c.x, c.y, { count: 18, speed: 120, life: 0.7 });
    sparks.ring(c.x, c.y, { radius: Math.max(c.w, c.h) * 0.8 });
    sound.land();
    haptic.tap();
  }, () => { flying = false; });

  renderDrawn();
  if (picked.length < spread.positions.length) { pickHint(); return; }
  slotEls.forEach((x) => x.box.classList.remove("next"));
  say("Все карты на столе");
  fanCards.forEach((x, k) => x.el.animate(
    [{ opacity: 1, transform: fanTransform(x) }, { opacity: 0, transform: `${fanTransform(x)} translateY(140px)` }],
    { duration: 520, delay: k * 22, easing: "ease-in", fill: "forwards" }));
  await wait(900);
  toReveal();
}

// ---------- turning the cards over ----------

function toReveal() {
  fanEl.replaceChildren();
  fanCards = [];
  setStage("reveal");
  fitTable();
  layoutSlots();
  revealHint();
  startTilt();
}

const isOpen = (i) => picked[i]?.el.classList.contains("open");
const openedCount = () => picked.filter((p, i) => isOpen(i)).length;

function revealHint() {
  const n = spread.positions.length;
  if (openedCount() < n) {
    say(n === 1 ? "Коснись карты, чтобы перевернуть" : "Открывай по одной или все сразу");
    primary.set(n === 1 ? "Открыть карту" : "Открыть все карты", openAll);
    return;
  }
  say(tiltAlive ? "Наклони телефон или коснись карты" : "Коснись карты, чтобы рассмотреть её");
  primary.set("Растолковать в чате", finish);
}

function openCard(i) {
  const p = picked[i];
  if (!p || (stage() !== "reveal")) return;
  if (isOpen(i)) { zoom(i); return; }
  const d = describe(i);
  p.el.classList.add("open");
  p.el.setAttribute("aria-label", `${d.pos.name}: ${d.card.name}`);
  slotEls[i].label?.classList.add("open");
  haptic.flip();
  sound.whoosh();
  const major = d.card.suit === "major";
  setTimeout(() => {
    const c = centre(p.el);
    if (major) {
      p.el.classList.add("major");
      sparks.burst(c.x, c.y, { count: 64, speed: 270, life: 1.3, size: 2.6, up: 40 });
      sparks.ring(c.x, c.y, { radius: Math.max(c.w, c.h) * 1.3, width: 3, life: 0.9 });
      sparks.ring(c.x, c.y, { radius: Math.max(c.w, c.h) * 0.8, color: accentRgb(), life: 0.7 });
      sound.chime(true);
      haptic.heavy();
    } else {
      sparks.burst(c.x, c.y, { count: 22, color: accentRgb(), speed: 150, life: 0.8 });
      sound.chime(false);
    }
  }, 430);
  setTimeout(() => p.el.classList.add("settled"), 1100); // from now on the card follows the phone tilt
  renderDrawn(i);
  revealHint();
  if (openedCount() === spread.positions.length) setTimeout(drawConstellation, 1000);
}

function openAll() {
  const closed = picked.map((p, i) => i).filter((i) => !isOpen(i));
  closed.forEach((i, k) => setTimeout(() => openCard(i), k * 260));
}

function renderDrawn(fresh = -1) {
  drawnEl.replaceChildren();
  spread.positions.forEach((pos, i) => {
    const li = document.createElement("li");
    const open = isOpen(i);
    li.className = (open ? "" : "hidden") + (i === fresh ? " fresh" : "");
    li.innerHTML = '<span class="n"></span><span class="t"></span><span class="k"></span>';
    li.querySelector(".n").textContent = i + 1;
    if (open) {
      const d = describe(i);
      const name = d.card.suit === "major" ? `<span class="arc">${esc(d.card.name)}</span>` : esc(d.card.name);
      li.querySelector(".t").innerHTML = `${esc(pos.name)} — ${name}${d.reversed ? " <em>перевёрнутая</em>" : ""}`;
      li.querySelector(".k").textContent = d.keys;
    } else {
      li.querySelector(".t").textContent = `${pos.name} — ${picked[i] ? "карта ещё закрыта" : "карта не вытянута"}`;
      li.querySelector(".k").textContent = pos.meaning;
    }
    drawnEl.append(li);
  });
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// All cards open: a constellation joins them in the order of the spread.
function drawConstellation(animate = true) {
  if (stage() !== "reveal" && stage() !== "sending") return;
  const t = table.getBoundingClientRect();
  const pts = picked.map((p) => { const c = centre(p.el); return [c.x - t.left, c.y - t.top]; });
  const NS = "http://www.w3.org/2000/svg";
  linesEl.replaceChildren();
  if (pts.length > 1) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
    linesEl.append(path);
    path.style.setProperty("--len", `${Math.ceil(path.getTotalLength()) + 2}`);
    if (!animate) path.style.animation = "none";
  }
  pts.forEach(([x, y], i) => {
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", 2.4);
    dot.style.animationDelay = animate ? `${0.15 + i * 0.12}s` : "0s";
    linesEl.append(dot);
  });
  if (animate) {
    sound.chime(false);
    pts.forEach(([x, y], i) => setTimeout(() => sparks.burst(t.left + x, t.top + y, { count: 8, speed: 70, life: 0.6 }), 150 + i * 120));
  }
}

// ---------- phone tilt: open cards and the close-up follow it ----------

let tiltAlive = false, tiltStarted = false, base = null, tiltNext = null, tiltNow = [0, 0];

// Once a frame, the tilt is written straight onto each open card (and the close-up): a variable on a
// container or on :root would restyle every element below it on each phone movement.
function applyTilt(tx, ty) {
  if (!tiltNext) requestAnimationFrame(() => {
    // ease towards the target instead of a CSS transition, which would restart on every sensor reading
    tiltNow = [tiltNow[0] + (tiltNext[0] - tiltNow[0]) * 0.45, tiltNow[1] + (tiltNext[1] - tiltNow[1]) * 0.45];
    const [x, y] = tiltNow;
    tiltNext = null;
    const turn = `rotateY(${(180 + y).toFixed(2)}deg) rotateX(${x.toFixed(2)}deg)`;
    const foil = `${(50 + y * 3.2).toFixed(1)}%`;
    for (const p of picked) {
      if (!p.el.classList.contains("settled")) continue;
      p.inner ??= p.el.querySelector(".card-inner");
      p.front ??= p.el.querySelector(".front");
      p.inner.style.transform = turn;
      p.front.style.setProperty("--foil", foil);
    }
    const z = $("zoom-card");
    if (!$("zoom").hidden) {
      z.style.transform = `perspective(900px) rotateY(${y.toFixed(2)}deg) rotateX(${x.toFixed(2)}deg)`;
      z.style.setProperty("--foil", foil);
    }
  });
  tiltNext = [tx, ty];
}

function startTilt() {
  if (tiltStarted) return;
  tiltStarted = true;
  const DO = tg?.DeviceOrientation;
  if (inTelegram && DO && tg.isVersionAtLeast?.("8.0")) {
    tg.onEvent("deviceOrientationChanged", () => {
      const g = DO.gamma, b = DO.beta;
      if (g == null || b == null) return;
      tiltAlive = true;
      if (!base) base = { g, b };
      base.g += (g - base.g) * 0.015; // slowly re-centre: holding still returns the card to neutral
      base.b += (b - base.b) * 0.015;
      applyTilt(clamp((-(b - base.b) * 180) / Math.PI * 0.55, -12, 12), clamp(((g - base.g) * 180) / Math.PI * 0.7, -15, 15));
    });
    safely(() => DO.start({ refresh_rate: 40 }));
  }
  // a finger or mouse moving over the page tilts the cards too
  addEventListener("pointermove", (e) => {
    if (tiltAlive || (stage() !== "reveal" && $("zoom").hidden)) return;
    applyTilt((0.5 - e.clientY / innerHeight) * 14, (e.clientX / innerWidth - 0.5) * 20);
  });
}

function stopTilt() {
  if (tiltStarted && tg?.DeviceOrientation) safely(() => tg.DeviceOrientation.stop());
  tiltStarted = false;
  tiltAlive = false;
  base = null;
}

// ---------- the positions on the table ----------

function geometry(tableHeight = fittedHeight ?? table.clientHeight) {
  const layout = LAYOUT[spread.key];
  const L = spread.key !== "celtic" ? 24 : 0;
  const W = table.clientWidth - PAD * 2;
  const H = tableHeight - PAD * 2 - (stage() === "pick" || stage() === "shuffle" ? FAN_ZONE - 10 : 0);
  const xs = layout.map((p) => p[0]), ys = layout.map((p) => p[1]);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const GX = 1.22, GY = spread.key === "celtic" ? 1.1 : 1.06;
  const rows = spanY * GY + 1;
  const w = Math.max(26, Math.min(W / (spanX * GX + 1), (H - L * rows) / (CARD_RATIO * rows), 118));
  const h = w * CARD_RATIO;
  const cx = PAD + W / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * w * GX;
  const cy = PAD + (H - (spanY * (h + L) * GY + h + L)) / 2 + h / 2 - Math.min(...ys) * (h + L) * GY;
  return layout.map(([x, y, cross]) => ({
    left: cx + x * w * GX - w / 2, top: cy + y * (h + L) * GY - h / 2, w, h, cross: Boolean(cross),
    contentHeight: spanY * (h + L) * GY + h + L + PAD * 2,
  }));
}

function buildSlots() {
  slotsEl.replaceChildren();
  linesEl.replaceChildren();
  slotEls = spread.positions.map((pos, i) => {
    const box = document.createElement("div");
    box.className = "slot";
    if (LAYOUT[spread.key][i][2]) box.classList.add("cross");
    slotsEl.append(box);
    let label = null, num = null;
    if (spread.key === "celtic") {
      num = document.createElement("span");
      num.className = "slot-num";
      num.textContent = i + 1;
      slotsEl.append(num);
    } else {
      label = document.createElement("span");
      label.className = "slot-label";
      label.textContent = pos.name;
      slotsEl.append(label);
    }
    return { box, label, num };
  });
  layoutSlots();
}

function placeCard(i, g = geometry()[i]) {
  const el = picked[i]?.el;
  if (!el) return;
  el.style.left = `${g.left}px`;
  el.style.top = `${g.top}px`;
  el.style.width = `${g.w}px`;
}

// Without the fan the table shrinks to the spread, so the list of cards below stays in view.
function fitTable() {
  fittedHeight = null;
  table.style.transition = "none";
  table.style.height = "";
  const full = table.clientHeight;
  table.style.height = `${full}px`;
  table.getBoundingClientRect();
  table.style.transition = "";
  fittedHeight = Math.min(full, Math.ceil(geometry(full)[0].contentHeight));
  table.style.height = `${fittedHeight}px`;
}

function layoutSlots() {
  if (!spread || !slotEls.length) return;
  geometry().forEach((g, i) => {
    const s = slotEls[i];
    Object.assign(s.box.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.w}px`, height: `${g.h}px` });
    if (s.label) Object.assign(s.label.style, { left: `${g.left + g.w / 2}px`, top: `${g.top + g.h + 3}px` });
    if (s.num) { // corner badge; the crossing card gets its badge at its right end
      const x = g.cross ? g.left + g.w / 2 + g.h / 2 - 12 : g.left - 8;
      const y = g.cross ? g.top + g.h / 2 + g.w / 2 - 12 : g.top - 8;
      Object.assign(s.num.style, { left: `${x}px`, top: `${y}px` });
    }
    placeCard(i, g);
  });
}

function relayout() {
  if (stage() === "reveal") fitTable();
  layoutSlots();
  if (linesEl.childElementCount) setTimeout(() => drawConstellation(false), 550);
}

table.addEventListener("transitionend", (e) => { if (e.target === table && e.propertyName === "height") layoutSlots(); });

// ---------- a card up close ----------

function zoom(i) {
  const d = describe(i);
  const box = $("zoom-card");
  box.replaceChildren();
  box.className = "zoom-card" + (d.reversed ? " reversed" : "");
  const img = new Image();
  img.src = `cards/${picked[i].id}.webp`;
  img.alt = d.card.name;
  box.append(img);
  $("zoom-pos").textContent = `${i + 1}. ${d.pos.name} — ${d.pos.meaning}`;
  $("zoom-name").textContent = d.card.name + (d.reversed ? " (перевёрнутая)" : "");
  $("zoom-keys").textContent = d.keys;
  $("zoom").hidden = false;
  $("zoom-close").focus();
  sound.whoosh();
  haptic.tap();
}
$("zoom-close").addEventListener("click", () => { $("zoom").hidden = true; });
$("zoom").addEventListener("click", (e) => { if (e.target.id === "zoom") $("zoom").hidden = true; });

// ---------- the end: the cards gather into light and go to the chat ----------

async function finish() {
  if (stage() !== "reveal") return;
  const payload = {
    v: 1,
    spread: spread.key,
    q: $("question").value.trim().slice(0, 400),
    persona,
    cards: picked.map(({ id, r }) => ({ id, r })),
  };
  setStage("sending");
  safely(() => primary.hide());
  say("Карты уходят к толкователю…");
  const t = table.getBoundingClientRect();
  const target = { x: t.left + t.width / 2, y: t.top + Math.min(90, t.height * 0.2) };
  const cards = picked.map((p) => centre(p.el));
  cards.forEach((c) => sparks.ring(c.x, c.y, { radius: Math.max(c.w, c.h) * 0.75, life: 0.6 }));
  sparks.gather(cards, target, accentRgb(), Math.min(44, Math.ceil(220 / cards.length)));
  sound.rise();
  haptic.done();
  await wait(1150);
  sparks.burst(target.x, target.y, { count: 90, speed: 320, life: 1.4, size: 2.8, up: 60 });
  sparks.ring(target.x, target.y, { radius: 160, width: 3, life: 1 });
  sparks.ring(target.x, target.y, { radius: 100, color: accentRgb(), life: 0.8 });
  haptic.heavy();
  await wait(450);

  if (inTelegram && !tg.initDataUnsafe?.query_id) {
    try {
      tg.sendData(JSON.stringify(payload)); // Telegram closes the table; the reading continues in the chat
      return;
    } catch (e) {
      report(e);
    }
  } else {
    note.textContent = inTelegram
      ? "Карты не могут уйти в чат из этого окна. Открой стол кнопкой «Стол гадалки» под полем ввода в чате с ботом."
      : "Это стол вне Telegram. Открой его в боте кнопкой «Стол гадалки», и толкование придёт в чат.";
    note.hidden = false;
  }
  setStage("reveal");
  revealHint();
}

function reset() {
  $("zoom").hidden = true;
  note.hidden = true;
  table.style.height = "";
  fittedHeight = null;
  fanEl.replaceChildren();
  drawnEl.replaceChildren();
  linesEl.replaceChildren();
  [...deckEl.children].forEach((c) => c.getAnimations().forEach((a) => a.cancel()));
  fanCards = [];
  picked = [];
  hover = null;
  stopTilt();
  toSetup();
  previewSpread();
}

// ---------- start ----------

function intro() {
  requestAnimationFrame(() => app.classList.add("lit"));
  [...deckEl.children].forEach((c, i) => c.animate([
    { transform: `translate(0, -110px) rotate(${(i % 2 ? 1 : -1) * (6 + i)}deg)`, opacity: 0 },
    { transform: rest(i), opacity: 1 },
  ], { duration: 650, delay: 350 + i * 45, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  if (!calm) motes.start();
}

async function main() {
  setupTelegram();
  try {
    const res = await fetch("data.json?v=5");
    data = await res.json();
  } catch (e) {
    note.textContent = "Не удалось загрузить колоду. Проверь интернет и открой стол заново.";
    note.hidden = false;
    return;
  }
  cardsById = Object.fromEntries(data.cards.map((c) => [c.id, c]));
  renderSetup();
  document.addEventListener("pointerdown", unlock, { passive: true });
  soundBtn.setAttribute("aria-pressed", String(isOn()));
  soundBtn.addEventListener("click", () => {
    setOn(!isOn());
    soundBtn.setAttribute("aria-pressed", String(isOn()));
    sound.tick();
  });
  if (!inTelegram) primaryBtn.addEventListener("click", () => primary.handler?.());
  addEventListener("resize", relayout);
  toSetup();
  previewSpread();
  intro();
}

main();
