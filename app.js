// Стол гадалки — Telegram Mini App for TarotAI. Static page: no server of its own.
// The user shuffles, pulls cards from a fan and turns them over; the pulled cards go back to the bot
// with Telegram.WebApp.sendData, and the bot writes the interpretation in the chat (bot/handlers/table.py).
// sendData works only when the page is opened from the bot's keyboard button «🔮 Стол гадалки».

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg && tg.platform && tg.platform !== "unknown");
const params = new URLSearchParams(location.search);
const unlocked = (params.get("tier") || "free") !== "free"; // decoration only: the bot re-checks access

const REVERSED_P = 0.35; // same as the bot's REVERSED_PROBABILITY default
const FAN_SIZE = { day: 12, three: 13, five: 15, celtic: 18 };
const ACCENT = { spirit: "#9B7BFF", advisor: "#4FB3A9", friend: "#E68AB8" };
// Positions in card units: [x, y, crossing]. Same arrangement as the bot's spread pictures (bot/images.py).
const LAYOUT = {
  day: [[0, 0]],
  three: [[-1, 0], [0, 0], [1, 0]],
  five: [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]],
  celtic: [[0, 0], [0, 0, 1], [0, 1], [-1.2, 0], [0, -1], [1.2, 0], [2.6, 1.5], [2.6, 0.5], [2.6, -0.5], [2.6, -1.5]],
};
const FAN_ZONE = 150; // px at the bottom of the table taken by the fan while picking
const CARD_RATIO = 600 / 350;

const $ = (id) => document.getElementById(id);
const app = $("app"), table = $("table"), deckEl = $("deck"), slotsEl = $("slots"), fanEl = $("fan");
const hint = $("hint"), note = $("note"), drawnEl = $("drawn"), bar = $("bar"), primaryBtn = $("primary");

let data;               // data.json: cards, spreads, personas
let cardsById;
let spread;             // chosen spread
let persona = params.get("persona");
let fanCards = [];      // [{el, card}] still in the fan
let picked = [];        // [{id, r, el}] in position order
let slotEls = [];       // [{box, label, num}]
let fittedHeight = null; // table height after fitTable(); clientHeight lags behind while the height animates

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

// ---------- Telegram glue ----------

const haptic = { // vibration is a nicety: never let it break a tap
  tap: () => safely(() => tg?.HapticFeedback?.impactOccurred("light")),
  flip: () => safely(() => tg?.HapticFeedback?.impactOccurred("medium")),
  shuffle: () => safely(() => tg?.HapticFeedback?.impactOccurred("heavy")),
  done: () => safely(() => tg?.HapticFeedback?.notificationOccurred("success")),
};

// One primary action per stage: Telegram's own main button inside Telegram, our button in a browser.
const primary = {
  handler: null,
  set(text, handler, { enabled = true, visible = true } = {}) {
    this.handler = enabled ? handler : null;
    if (inTelegram) {
      if (!visible) { // Telegram throws on an empty button text, so hiding must not pass one
        tg.MainButton.hide();
        return;
      }
      tg.MainButton.setParams({
        text, color: "#D8B45A", text_color: "#0E0B1F", is_active: enabled, is_visible: true,
      });
      return;
    }
    bar.hidden = !visible;
    primaryBtn.textContent = text;
    primaryBtn.disabled = !enabled;
  },
  hide() { this.set("", null, { visible: false }); },
};

// A failing Telegram call must never stop the cards; the error is still shown for the bug report.
function safely(fn) {
  try { fn(); } catch (e) { report(e); }
}

function report(e) {
  console.error(e);
  const text = `Ошибка на столе: ${e?.message || e}. Пришли этот текст в чат с ботом, чтобы её исправили.`;
  const n = document.getElementById("note");
  if (n) { n.textContent = text; n.hidden = false; }
}
addEventListener("error", (e) => report(e.error || e.message));
addEventListener("unhandledrejection", (e) => report(e.reason));

function setupTelegram() {
  if (!inTelegram) return;
  bar.hidden = true;
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("#0E0B1F");
    tg.setBackgroundColor("#0E0B1F");
    tg.setBottomBarColor?.("#0E0B1F");
    tg.disableVerticalSwipes?.(); // pulling cards must not close the table
  } catch { /* older clients: cosmetic only */ }
  tg.MainButton.onClick(() => primary.handler?.());
  tg.BackButton.onClick(() => reset());
  tg.onEvent("viewportChanged", ({ isStateStable }) => isStateStable && layoutSlots());
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

  if (!data.personas.some((p) => p.key === persona)) persona = data.personas[0].key;
  const prow = document.createElement("div");
  prow.className = "personas-row";
  for (const p of data.personas) prow.append(option("persona", p.key, p.name, "", p.icon, { checked: p.key === persona }));
  $("personas").append(prow);
  $("personas").addEventListener("change", (e) => { persona = e.target.value; paintAccent(); });
  paintAccent();

  for (let i = 0; i < 6; i++) {
    const c = makeCard(null);
    c.style.transform = `translate(${-i * 1.4}px, ${-i * 1.4}px)`;
    deckEl.append(c);
  }
}

function paintAccent() {
  document.documentElement.style.setProperty("--accent", ACCENT[persona] || ACCENT.spirit);
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

// ---------- stages ----------

function setStage(stage) {
  app.dataset.stage = stage;
  if (inTelegram) safely(() => {
    if (stage === "setup") { tg.BackButton.hide(); tg.disableClosingConfirmation(); }
    else { tg.BackButton.show(); tg.enableClosingConfirmation(); }
  });
}

function toSetup() {
  setStage("setup");
  hint.textContent = "Выбери расклад и задай вопрос";
  primary.set("Перемешать колоду", shuffle);
}

function shuffle() {
  const key = document.querySelector('input[name="spread"]:checked')?.value;
  spread = data.spreads.find((s) => s.key === key);
  if (!spread) return;
  document.activeElement?.blur(); // close the phone keyboard
  const deck = shuffled(data.cards).slice(0, FAN_SIZE[spread.key] || 13);
  fanCards = deck.map((c) => ({ card: { id: c.id, r: chance(REVERSED_P) }, el: null }));
  picked = [];
  setStage("shuffle");
  hint.textContent = "Тасую колоду…";
  deckEl.classList.add("riffle");
  safely(() => primary.hide());
  haptic.shuffle();
  setTimeout(() => {
    deckEl.classList.remove("riffle");
    dealFan();
  }, 1250);
}

function dealFan() {
  setStage("pick");
  buildSlots();
  fanEl.replaceChildren();
  fanCards.forEach((f, i) => {
    const el = makeCard(null);
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `Карта ${i + 1} из веера`);
    el.style.opacity = "0";
    el.style.transform = "translateY(-140px) rotate(0deg)";
    el.addEventListener("click", () => pick(f));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(f); } });
    f.el = el;
    fanEl.append(el);
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fanCards.forEach((f, i) => {
      f.el.style.transitionDelay = `${i * 30}ms`;
      f.el.style.opacity = "1";
    });
    layoutFan();
    setTimeout(() => fanCards.forEach((f) => { f.el.style.transitionDelay = ""; }), 1200);
  }));
  pickHint();
}

function layoutFan() {
  const n = fanCards.length;
  const spreadDeg = Math.min(84, n * 5.2);
  fanCards.forEach((f, i) => {
    const a = n > 1 ? -spreadDeg / 2 + (i * spreadDeg) / (n - 1) : 0;
    f.angle = a;
    f.el.style.transform = `rotate(${a}deg)`;
  });
}

function pickHint() {
  const left = spread.positions.length - picked.length;
  hint.textContent = `Вытяни из веера ещё ${cardsWord(left)}`;
  slotEls.forEach((s, i) => s.box.classList.toggle("next", i === picked.length));
}

function pick(f) {
  if (app.dataset.stage !== "pick" || picked.length >= spread.positions.length || !fanCards.includes(f)) return;
  haptic.tap();
  const i = picked.length;
  const from = f.el.getBoundingClientRect();
  f.el.remove();
  fanCards = fanCards.filter((x) => x !== f);
  layoutFan();

  const el = makeCard(f.card);
  el.dataset.i = i;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `${spread.positions[i].name}: открыть карту`);
  if (LAYOUT[spread.key][i][2]) el.classList.add("cross");
  el.addEventListener("click", () => openCard(i));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCard(i); } });
  picked.push({ ...f.card, el });
  placeCard(i);
  slotsEl.append(el);

  { // fly from the fan to the position
    const to = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const scale = 62 / parseFloat(el.style.width);
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${f.angle}deg) scale(${scale})`;
    el.getBoundingClientRect();
    el.style.transition = "";
    el.style.transform = "";
  }

  renderDrawn();
  if (picked.length < spread.positions.length) { pickHint(); return; }
  slotEls.forEach((s) => s.box.classList.remove("next"));
  hint.textContent = "Все карты на столе";
  fanCards.forEach((x) => { x.el.style.opacity = "0"; x.el.style.pointerEvents = "none"; });
  setTimeout(toReveal, 550);
}

function toReveal() {
  fanEl.replaceChildren();
  fanCards = [];
  setStage("reveal");
  fitTable();
  layoutSlots();
  revealHint();
}

function openedCount() { return picked.filter((p) => p.el.classList.contains("open")).length; }

function revealHint() {
  const n = spread.positions.length, open = openedCount();
  if (open < n) {
    hint.textContent = n === 1 ? "Коснись карты, чтобы перевернуть" : "Открывай карты по одной или все сразу";
    primary.set(n === 1 ? "Открыть карту" : "Открыть все карты", openAll);
    return;
  }
  hint.textContent = "Коснись карты, чтобы рассмотреть её";
  primary.set("Растолковать в чате", finish);
}

function openCard(i) {
  const p = picked[i];
  if (!p || app.dataset.stage === "pick" || app.dataset.stage === "shuffle") return;
  if (p.el.classList.contains("open")) { zoom(i); return; }
  p.el.classList.add("open");
  p.el.setAttribute("aria-label", `${spread.positions[i].name}: ${describe(i).card.name}`);
  slotEls[i].label?.classList.add("open");
  haptic.flip();
  renderDrawn();
  revealHint();
}

function openAll() {
  const closed = picked.map((p, i) => i).filter((i) => !picked[i].el.classList.contains("open"));
  closed.forEach((i, k) => setTimeout(() => openCard(i), k * 220));
}

function renderDrawn() {
  drawnEl.replaceChildren();
  spread.positions.forEach((pos, i) => {
    const li = document.createElement("li");
    const open = picked[i]?.el.classList.contains("open");
    li.className = open ? "" : "hidden";
    li.innerHTML = '<span class="n"></span><span class="t"></span><span class="k"></span>';
    li.querySelector(".n").textContent = i + 1;
    if (open) {
      const d = describe(i);
      li.querySelector(".t").innerHTML = `${esc(pos.name)} — ${esc(d.card.name)}${d.reversed ? " <em>перевёрнутая</em>" : ""}`;
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

// ---------- the positions on the table ----------

const PAD = 14;

function geometry(tableHeight = fittedHeight ?? table.clientHeight) {
  const layout = LAYOUT[spread.key];
  const labels = spread.key !== "celtic";
  const L = labels ? 24 : 0;
  const pad = PAD;
  const W = table.clientWidth - pad * 2;
  const H = tableHeight - pad * 2 - (app.dataset.stage === "pick" ? FAN_ZONE - 10 : 0);
  const xs = layout.map((p) => p[0]), ys = layout.map((p) => p[1]);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const GX = 1.22, GY = spread.key === "celtic" ? 1.1 : 1.06;
  const wByW = W / (spanX * GX + 1);
  const rows = spanY * GY + 1;
  const wByH = (H - L * rows) / (CARD_RATIO * rows);
  const w = Math.max(30, Math.min(wByW, wByH, 118));
  const h = w * CARD_RATIO;
  const cx = pad + W / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * w * GX;
  const cy = pad + (H - (spanY * (h + L) * GY + h + L)) / 2 + h / 2 - Math.min(...ys) * (h + L) * GY;
  return layout.map(([x, y, cross]) => ({
    left: cx + x * w * GX - w / 2, top: cy + y * (h + L) * GY - h / 2, w, h, cross: Boolean(cross), L,
    contentHeight: spanY * (h + L) * GY + h + L + pad * 2,
  }));
}

function buildSlots() {
  slotsEl.replaceChildren();
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

function placeCard(i) {
  const g = geometry()[i], el = picked[i]?.el;
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
    if (s.num) { // corner badge; the crossing card gets its badge on the other side
      const x = g.cross ? g.left + g.w / 2 + g.h / 2 - 12 : g.left - 8;
      const y = g.cross ? g.top + g.h / 2 + g.w / 2 - 12 : g.top - 8;
      Object.assign(s.num.style, { left: `${x}px`, top: `${y}px` });
    }
    placeCard(i);
  });
}

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
}
$("zoom-close").addEventListener("click", () => { $("zoom").hidden = true; });
$("zoom").addEventListener("click", (e) => { if (e.target.id === "zoom") $("zoom").hidden = true; });

// ---------- the end: hand the cards to the bot ----------

function finish() {
  const payload = {
    v: 1,
    spread: spread.key,
    q: $("question").value.trim().slice(0, 400),
    persona,
    cards: picked.map(({ id, r }) => ({ id, r })),
  };
  if (inTelegram && !tg.initDataUnsafe?.query_id) {
    try {
      haptic.done();
      tg.sendData(JSON.stringify(payload)); // Telegram closes the table; the reading continues in the chat
      return;
    } catch (e) {
      console.error(e);
    }
  }
  showNote(inTelegram
    ? "Карты не могут уйти в чат из этого окна. Открой стол кнопкой «🔮 Стол гадалки» под полем ввода в чате с ботом."
    : "Это стол вне Telegram. Открой его в боте кнопкой «🔮 Стол гадалки», и толкование придёт в чат.");
}

function showNote(text) {
  note.textContent = text;
  note.hidden = false;
}

function reset() {
  $("zoom").hidden = true;
  table.style.height = "";
  fittedHeight = null;
  note.hidden = true;
  slotsEl.replaceChildren();
  fanEl.replaceChildren();
  drawnEl.replaceChildren();
  fanCards = [];
  picked = [];
  slotEls = [];
  spread = null;
  toSetup();
}

// ---------- start ----------

async function main() {
  setupTelegram();
  try {
    const res = await fetch("data.json");
    data = await res.json();
  } catch (e) {
    showNote("Не удалось загрузить колоду. Проверь интернет и открой стол заново.");
    return;
  }
  cardsById = Object.fromEntries(data.cards.map((c) => [c.id, c]));
  renderSetup();
  if (!inTelegram) primaryBtn.addEventListener("click", () => primary.handler?.());
  addEventListener("resize", () => { if (app.dataset.stage === "reveal") fitTable(); layoutSlots(); });
  toSetup();
}

main();
