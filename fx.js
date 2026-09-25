// Visual effects for the table: drifting candle motes (ambient) and a spark system (answers to the user's taps).
// Both draw on canvases; the spark loop runs only while sparks are alive, so an idle table costs nothing.

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

// Canvas size is tracked by a ResizeObserver: asking for it every frame would force style and layout work.
function sized(canvas) {
  const box = { width: 1, height: 1 };
  const apply = (w, h) => {
    box.width = Math.max(1, w);
    box.height = Math.max(1, h);
    canvas.width = Math.round(box.width * DPR);
    canvas.height = Math.round(box.height * DPR);
  };
  const r = canvas.getBoundingClientRect();
  apply(r.width, r.height);
  new ResizeObserver(([e]) => apply(e.contentRect.width, e.contentRect.height)).observe(canvas);
  return box;
}

// A glowing dot is drawn once per colour into a small sprite and then stamped with drawImage:
// building a gradient for every particle in every frame is what made the effects stutter on phones.
const sprites = new Map();
function glow([r, g, b]) {
  const key = `${r},${g},${b}`;
  let s = sprites.get(key);
  if (!s) {
    s = document.createElement("canvas");
    s.width = s.height = 64;
    const c = s.getContext("2d");
    const grad = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.3, `rgba(${r},${g},${b},.5)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    c.fillStyle = grad;
    c.fillRect(0, 0, 64, 64);
    sprites.set(key, s);
  }
  return s;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- motes: dust in the candle light, drifting up ----------

export class Motes {
  constructor(canvas, count = 34) {
    this.canvas = canvas;
    this.box = sized(canvas);
    this.ctx = canvas.getContext("2d");
    this.count = count;
    this.items = [];
    this.running = false;
    this.accent = [155, 123, 255];
    this.tick = this.tick.bind(this);
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
  }

  seed(r) {
    this.items = Array.from({ length: this.count }, () => this.mote(r, true));
  }

  mote(r, anywhere) {
    return {
      x: rand(0, r.width), y: anywhere ? rand(0, r.height) : r.height + 6,
      r: rand(0.6, 1.9), vy: rand(6, 18), sway: rand(4, 14), phase: rand(0, TAU), speed: rand(0.4, 1.1),
      gold: Math.random() < 0.72, tw: rand(0, TAU),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  stop() { this.running = false; }

  tick(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const r = this.box;
    if (this.items.length !== this.count) this.seed(r);
    const c = this.ctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    c.globalCompositeOperation = "lighter";
    for (const m of this.items) {
      m.y -= m.vy * dt;
      m.phase += m.speed * dt;
      m.tw += dt * 2.2;
      if (m.y < -6) Object.assign(m, this.mote(r, false));
      const x = m.x + Math.sin(m.phase) * m.sway;
      // brighter near the candle at the top centre, dimmer towards the edges
      const light = 1 - Math.min(1, Math.hypot(x - r.width / 2, m.y - r.height * 0.1) / (r.height * 0.95));
      const a = (0.18 + 0.55 * light) * (0.6 + 0.4 * Math.sin(m.tw));
      const s = m.r * 4;
      c.globalAlpha = Math.max(0, a);
      c.drawImage(glow(m.gold ? [242, 217, 138] : this.accent), x - s, m.y - s, s * 2, s * 2);
    }
    c.globalAlpha = 1;
    requestAnimationFrame(this.tick);
  }
}

// ---------- sparks: bursts, rings, trails and the final gathering ----------

export class Sparks {
  constructor(canvas) {
    this.canvas = canvas;
    this.box = sized(canvas);
    this.ctx = canvas.getContext("2d");
    this.parts = [];
    this.rings = [];
    this.running = false;
    this.tick = this.tick.bind(this);
  }

  wake() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  burst(x, y, { count = 24, color = [242, 217, 138], speed = 160, life = 0.9, size = 2.2, gravity = 60, up = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU), v = speed * rand(0.35, 1);
      this.parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, life: life * rand(0.6, 1), age: 0,
        size: size * rand(0.5, 1.2), color: Math.random() < 0.3 ? [255, 246, 214] : color, gravity, drag: 2.2,
      });
    }
    this.wake();
  }

  trail(x, y, color = [242, 217, 138]) {
    for (let i = 0; i < 2; i++) {
      this.parts.push({
        x: x + rand(-6, 6), y: y + rand(-6, 6), vx: rand(-20, 20), vy: rand(-10, 25), life: rand(0.35, 0.7), age: 0,
        size: rand(1, 2.4), color, gravity: 30, drag: 1.5,
      });
    }
    this.wake();
  }

  ring(x, y, { color = [242, 217, 138], radius = 90, life = 0.7, width = 2 } = {}) {
    this.rings.push({ x, y, color, radius, life, age: 0, width });
    this.wake();
  }

  // particles fly from each point to the target: the reading "gathers" before it goes to the chat
  gather(points, target, color = [242, 217, 138], perPoint = 44) {
    for (const p of points) {
      for (let i = 0; i < perPoint; i++) {
        this.parts.push({
          x: p.x + rand(-p.w / 2, p.w / 2), y: p.y + rand(-p.h / 2, p.h / 2), life: rand(1.05, 1.25), age: 0,
          size: rand(1.6, 3.4), color: Math.random() < 0.35 ? [255, 246, 214] : color,
          homing: { x: target.x, y: target.y, delay: rand(0, 0.25) }, vx: rand(-40, 40), vy: rand(-40, 40),
        });
      }
    }
    this.wake();
  }

  tick(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const r = this.box;
    const c = this.ctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    c.globalCompositeOperation = "lighter";

    this.parts = this.parts.filter((p) => (p.age += dt) < p.life);
    for (const p of this.parts) {
      if (p.homing) {
        const t = Math.max(0, (p.age - p.homing.delay) / (p.life - p.homing.delay));
        const k = t * t * (3 - 2 * t);
        p.x += (p.homing.x - p.x) * Math.min(1, k * dt * 9) + p.vx * dt * (1 - k);
        p.y += (p.homing.y - p.y) * Math.min(1, k * dt * 9) + p.vy * dt * (1 - k);
      } else {
        p.vx *= 1 - p.drag * dt;
        p.vy = p.vy * (1 - p.drag * dt) + p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      const u = p.age / p.life;
      // gathering sparks grow brighter as they converge and wink out on arrival; the rest simply fade
      const a = p.homing ? Math.min(1, 0.45 + u) * (u > 0.9 ? (1 - u) / 0.1 : 1) : 1 - u;
      const s = p.size * (0.6 + 0.6 * a) * 3.2;
      c.globalAlpha = Math.max(0, a);
      c.drawImage(glow(p.color), p.x - s, p.y - s, s * 2, s * 2);
    }
    c.globalAlpha = 1;

    this.rings = this.rings.filter((q) => (q.age += dt) < q.life);
    for (const q of this.rings) {
      const t = q.age / q.life, e = 1 - (1 - t) ** 3;
      const [cr, cg, cb] = q.color;
      c.strokeStyle = `rgba(${cr},${cg},${cb},${(1 - t) * 0.8})`;
      c.lineWidth = q.width * (1 - t) + 0.5;
      c.beginPath();
      c.arc(q.x, q.y, q.radius * e, 0, TAU);
      c.stroke();
    }

    if (this.parts.length || this.rings.length) {
      requestAnimationFrame(this.tick);
    } else {
      c.clearRect(0, 0, r.width, r.height);
      this.running = false;
    }
  }
}
