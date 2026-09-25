// Visual effects for the table: drifting candle motes (ambient) and a spark system (answers to the user's taps).
// Both draw on canvases; the spark loop runs only while sparks are alive, so an idle table costs nothing.

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * DPR)), h = Math.max(1, Math.round(r.height * DPR));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return r;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- motes: dust in the candle light, drifting up ----------

export class Motes {
  constructor(canvas, count = 38) {
    this.canvas = canvas;
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
    const r = fit(this.canvas);
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
      const [cr, cg, cb] = m.gold ? [242, 217, 138] : this.accent;
      const g = c.createRadialGradient(x, m.y, 0, x, m.y, m.r * 4);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, m.y, m.r * 4, 0, TAU);
      c.fill();
    }
    requestAnimationFrame(this.tick);
  }
}

// ---------- sparks: bursts, rings, trails and the final gathering ----------

export class Sparks {
  constructor(canvas) {
    this.canvas = canvas;
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
  gather(points, target, color = [242, 217, 138]) {
    for (const p of points) {
      for (let i = 0; i < 44; i++) {
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
    const r = fit(this.canvas);
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
      const [cr, cg, cb] = p.color;
      const s = p.size * (0.6 + 0.6 * a);
      const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, s * 3.2);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      g.addColorStop(0.35, `rgba(${cr},${cg},${cb},${a * 0.5})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(p.x, p.y, s * 3.2, 0, TAU);
      c.fill();
    }

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
