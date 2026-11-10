/* Explainer Studio — motion-graphics renderer + UI.
 *
 * The whole video is a pure function of time: renderFrame(t) draws the frame at
 * t seconds. That makes seeking, previewing and recording all the same code.
 */
(() => {
  "use strict";

  const W = 1280, H = 720;
  const FONT = 'Poppins, "Noto Sans Devanagari", system-ui, sans-serif';
  const PALETTES = {
    sunset: { bg: ["#2b1055", "#7597de"], a: ["#ff6b6b", "#feca57", "#ff9ff3", "#48dbfb"], text: "#ffffff", ink: "#1b1033" },
    ocean:  { bg: ["#03203c", "#0b6e99"], a: ["#00d2d3", "#54a0ff", "#a29bfe", "#feca57"], text: "#ffffff", ink: "#021626" },
    forest: { bg: ["#0b3d2e", "#2d8f6f"], a: ["#c7f464", "#feca57", "#55efc4", "#ff7675"], text: "#ffffff", ink: "#072a1f" },
    neon:   { bg: ["#0a0a1a", "#2a0845"], a: ["#00f5d4", "#f15bb5", "#fee440", "#9b5de5"], text: "#ffffff", ink: "#0a0a1a" },
    candy:  { bg: ["#ff9a9e", "#a18cd1"], a: ["#ffffff", "#5f27cd", "#ff6b81", "#1dd1a1"], text: "#ffffff", ink: "#3a1450" },
    mono:   { bg: ["#111111", "#3a3a3a"], a: ["#ffd32a", "#ffffff", "#ff5e57", "#0fbcf9"], text: "#ffffff", ink: "#111111" },
  };
  const TRANS = 0.45; // seconds of wipe on each side of a scene boundary
  let safeBottom = H - 30; // lowest y scene content may use; set per frame above the subtitle box

  // ------------------------------------------------------------------ state
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");
  let board = null;        // {title, palette, scenes}
  let starts = [];         // scene start times
  let total = 0;
  let t = 0;               // playhead (seconds)
  let playing = false;
  let playStart = 0;       // performance.now() at playhead 0
  let lastScene = -1;
  let audio = null;        // {ctx, master}
  let recorder = null;
  let webmBlob = null;
  let language = "english";

  // ------------------------------------------------------------------ easing + helpers
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const easeOut = (k) => 1 - Math.pow(1 - clamp(k), 3);
  const easeInOut = (k) => { k = clamp(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
  const easeBack = (k) => { k = clamp(k); const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
  const elastic = (k) => { k = clamp(k); return k === 0 || k === 1 ? k : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI) / 3) + 1; };
  const prog = (lt, start, dur) => clamp((lt - start) / dur);
  function rand(seed) { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  function font(weight, size) { return `${weight} ${size}px ${FONT}`; }

  function wrap(text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  /* Pick the largest font size (<= size) whose wrapped text fits in maxLines. */
  function fit(text, weight, size, maxWidth, maxLines, min = 18) {
    let s = size, lines;
    for (; s >= min; s -= 2) {
      ctx.font = font(weight, s);
      lines = wrap(text, maxWidth);
      if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) break;
    }
    ctx.font = font(weight, Math.max(s, min));
    return { size: Math.max(s, min), lines: lines || [] };
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Draw lines word-by-word, each word sliding up with a stagger. */
  function kinetic(lines, x, y, size, lt, start, opts = {}) {
    const lh = size * (opts.lh || 1.15);
    const align = opts.align || "center";
    let wi = 0;
    lines.forEach((line, li) => {
      const words = line.split(" ");
      const widths = words.map((w) => ctx.measureText(w + " ").width);
      const lineW = ctx.measureText(line).width;
      let cx = align === "center" ? x - lineW / 2 : x;
      words.forEach((w, i) => {
        const k = easeBack(prog(lt, start + wi * (opts.stagger || 0.07), 0.55));
        ctx.save();
        ctx.globalAlpha *= clamp(k * 1.4);
        ctx.textAlign = "left";
        ctx.fillText(w, cx, y + li * lh + (1 - k) * size * 0.7);
        ctx.restore();
        cx += widths[i];
        wi++;
      });
    });
    return lines.length * lh;
  }

  function emoji(ch, x, y, size, scale = 1, rot = 0, glow = false) {
    if (!ch) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    if (glow) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.95);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, size * 0.95, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ch, 0, size * 0.05);
    ctx.restore();
  }

  // ------------------------------------------------------------------ background
  function background(p, time) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    const shift = (Math.sin(time * 0.15) + 1) / 2;
    g.addColorStop(0, p.bg[0]);
    g.addColorStop(lerp(0.6, 1, shift), p.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // soft floating blobs
    for (let i = 0; i < 6; i++) {
      const bx = (rand(i) * W + Math.sin(time * 0.2 + i) * 80) % W;
      const by = (rand(i + 10) * H + Math.cos(time * 0.17 + i * 2) * 60) % H;
      const r = 120 + rand(i + 20) * 180;
      const rg = ctx.createRadialGradient(bx, by, 0, bx, by, r);
      rg.addColorStop(0, p.a[i % p.a.length] + "33");
      rg.addColorStop(1, p.a[i % p.a.length] + "00");
      ctx.fillStyle = rg;
      ctx.fillRect(bx - r, by - r, r * 2, r * 2);
    }
    // dot grid drifting
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    const off = (time * 12) % 40;
    for (let x = -40; x < W + 40; x += 40) for (let y = -40; y < H + 40; y += 40) {
      ctx.beginPath(); ctx.arc(x + off, y + off * 0.5, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    // floating geometric shapes
    for (let i = 0; i < 8; i++) {
      const sx = rand(i + 30) * W, sy = (rand(i + 40) * H - time * (10 + i * 3)) % (H + 100);
      const y = sy < -50 ? sy + H + 100 : sy;
      ctx.save();
      ctx.translate(sx, y);
      ctx.rotate(time * (0.2 + rand(i) * 0.4));
      ctx.strokeStyle = p.a[i % p.a.length] + "55";
      ctx.lineWidth = 3;
      const s = 10 + rand(i + 50) * 18;
      if (i % 3 === 0) { ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.stroke(); }
      else if (i % 3 === 1) ctx.strokeRect(-s, -s, s * 2, s * 2);
      else { ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s, s); ctx.lineTo(-s, s); ctx.closePath(); ctx.stroke(); }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ scenes
  function sceneTitle(s, lt, d, p) {
    // expanding rings
    for (let i = 0; i < 3; i++) {
      const k = easeOut(prog(lt, 0.1 + i * 0.15, 1.4));
      ctx.strokeStyle = p.a[i] + "88";
      ctx.lineWidth = 6 - i * 1.5;
      ctx.beginPath(); ctx.arc(W / 2, H / 2 - 40, k * (260 + i * 90), 0, Math.PI * 2); ctx.stroke();
    }
    const es = elastic(prog(lt, 0.15, 1.1));
    emoji(s.emoji, W / 2, 175, 110, es, Math.sin(lt * 2) * 0.08, true);
    ctx.fillStyle = p.text;
    ctx.textBaseline = "alphabetic";
    const f = fit(s.heading, 800, 84, W - 220, 2, 40);
    const h = kinetic(f.lines, W / 2, 340, f.size, lt, 0.4);
    const bar = easeInOut(prog(lt, 0.9, 0.7));
    ctx.fillStyle = p.a[0];
    roundRect(W / 2 - 160 * bar, 340 + h - f.size * 0.55, 320 * bar, 10, 5); ctx.fill();
    ctx.globalAlpha = easeOut(prog(lt, 1.2, 0.6));
    ctx.fillStyle = p.text;
    const sf = fit(s.subheading, 400, 32, W - 300, 2, 20);
    sf.lines.forEach((l, i) => { ctx.textAlign = "center"; ctx.fillText(l, W / 2, 340 + h + 30 + i * sf.size * 1.25 + (1 - ctx.globalAlpha) * 20); });
    ctx.globalAlpha = 1;
  }

  function heading(s, lt, p, y = 110, size = 54) {
    ctx.fillStyle = p.text;
    ctx.textBaseline = "alphabetic";
    const f = fit(s.heading, 800, size, W - 200, 2, 30);
    const h = kinetic(f.lines, W / 2, y, f.size, lt, 0.1, { stagger: 0.05 });
    const bar = easeInOut(prog(lt, 0.4, 0.6));
    ctx.fillStyle = p.a[1];
    roundRect(W / 2 - 60 * bar, y + h - f.size * 0.6, 120 * bar, 7, 4); ctx.fill();
    return y + h;
  }

  function sceneBullets(s, lt, d, p) {
    const top = heading(s, lt, p) + 30;
    const n = s.items.length;
    const gap = 18, ch = Math.min(110, (safeBottom - top - gap * (n - 1)) / n);
    s.items.forEach((it, i) => {
      const k = easeBack(prog(lt, 0.7 + i * 0.45, 0.6));
      const y = top + i * (ch + gap);
      const x = 170 + (1 - k) * 260;
      ctx.save();
      ctx.globalAlpha = clamp(k * 1.5);
      ctx.fillStyle = "rgba(255,255,255,0.13)";
      roundRect(x, y, W - 340, ch, 22); ctx.fill();
      ctx.fillStyle = p.a[i % p.a.length];
      roundRect(x, y, 10, ch, 5); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 70, y + ch / 2, ch * 0.36, 0, Math.PI * 2); ctx.fill();
      emoji(it.emoji || "•", x + 70, y + ch / 2, ch * 0.42, elastic(prog(lt, 0.9 + i * 0.45, 0.8)));
      ctx.fillStyle = p.text;
      const f = fit(it.text, 600, 36, W - 340 - 160, 2, 20);
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      f.lines.forEach((l, li) => ctx.fillText(l, x + 130, y + ch / 2 + (li - (f.lines.length - 1) / 2) * f.size * 1.2));
      ctx.restore();
    });
  }

  function parseValue(v) {
    const m = String(v).match(/^(\D*?)([\d][\d,]*\.?\d*)(.*)$/);
    if (!m) return null;
    const num = parseFloat(m[2].replace(/,/g, ""));
    const dec = (m[2].split(".")[1] || "").length;
    return { pre: m[1], num, dec, post: m[3], commas: m[2].includes(",") };
  }

  function sceneStat(s, lt, d, p) {
    // Lift the ring when a tall subtitle box leaves less room below it.
    const cx = W / 2, cy = Math.max(200, Math.min(300, safeBottom - 305)), R = Math.min(170, cy - 40);
    const k = easeOut(prog(lt, 0.3, 1.8));
    ctx.lineWidth = 22; ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = p.a[0];
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k * 0.78); ctx.stroke();
    // orbiting dot
    const ang = -Math.PI / 2 + Math.PI * 2 * k * 0.78;
    ctx.fillStyle = p.a[1];
    ctx.beginPath(); ctx.arc(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, 18 * elastic(prog(lt, 0.3, 1)), 0, Math.PI * 2); ctx.fill();

    const pv = parseValue(s.value);
    let shown = s.value;
    if (pv) {
      let n = (pv.num * k).toFixed(pv.dec);
      if (pv.commas) n = Number(n).toLocaleString("en-US", { minimumFractionDigits: pv.dec, maximumFractionDigits: pv.dec });
      shown = pv.pre + n + pv.post;
    }
    ctx.fillStyle = p.text; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const f = fit(shown.length < s.value.length ? s.value : shown, 800, 110, R * 1.7, 1, 30);
    const sc = easeBack(prog(lt, 0.2, 0.7));
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.font = font(800, f.size); ctx.fillText(shown, 0, 0); ctx.restore();
    emoji(s.emoji, cx + R * 0.95, cy - R * 0.85, 64, elastic(prog(lt, 0.8, 1)));
    ctx.textBaseline = "alphabetic";
    const hy = cy + R + 85;
    let hf = fit(s.heading, 600, 44, W - 260, 2, 24);
    if (hy + (hf.lines.length - 1) * hf.size * 1.15 > safeBottom) hf = fit(s.heading, 600, 44, W - 260, 1, 18);
    kinetic(hf.lines, W / 2, hy, hf.size, lt, 1.2, { stagger: 0.05 });
  }

  function sceneSteps(s, lt, d, p) {
    const top = heading(s, lt, p);
    const n = s.items.length;
    const margin = 170, span = W - margin * 2;
    const cy = top + 170;
    const lineK = easeInOut(prog(lt, 0.6, 0.6 + n * 0.5));
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 8; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(margin, cy); ctx.lineTo(margin + span, cy); ctx.stroke();
    ctx.strokeStyle = p.a[1];
    ctx.beginPath(); ctx.moveTo(margin, cy); ctx.lineTo(margin + span * lineK, cy); ctx.stroke();
    s.items.forEach((it, i) => {
      const x = n === 1 ? W / 2 : margin + (span * i) / (n - 1);
      const k = elastic(prog(lt, 0.6 + i * 0.5, 0.9));
      ctx.save(); ctx.translate(x, cy); ctx.scale(k, k);
      ctx.fillStyle = p.a[i % p.a.length];
      ctx.beginPath(); ctx.arc(0, 0, 58, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = p.ink; ctx.font = font(800, 46); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      if (it.emoji) emoji(it.emoji, 0, 0, 52); else ctx.fillText(String(i + 1), 0, 2);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = easeOut(prog(lt, 0.8 + i * 0.5, 0.5));
      ctx.fillStyle = p.text; ctx.textBaseline = "alphabetic";
      const f = fit(it.text, 600, 30, Math.min(260, span / Math.max(1, n - 1) - 20), 3, 18);
      f.lines.forEach((l, li) => { ctx.textAlign = "center"; ctx.fillText(l, x, cy + 115 + li * f.size * 1.2 + (1 - ctx.globalAlpha) * 20); });
      ctx.restore();
    });
  }

  function sceneComparison(s, lt, d, p) {
    const top = heading(s, lt, p, 100, 48);
    const pw = (W - 260) / 2;
    const subGap = s.subheading ? 56 : 0;
    const ph = Math.max(120, Math.min(H - top - 210, safeBottom - (top + 40) - subGap));
    const es = Math.min(96, ph * 0.4);
    [0, 1].forEach((side) => {
      const it = s.items[side];
      const k = easeOut(prog(lt, 0.4 + side * 0.25, 0.8));
      const x = side === 0 ? 100 - (1 - k) * 600 : W / 2 + 30 + (1 - k) * 600;
      const y = top + 40;
      ctx.fillStyle = side === 0 ? p.a[0] + "dd" : p.a[3] + "dd";
      roundRect(x, y, pw, ph, 28); ctx.fill();
      emoji(it.emoji, x + pw / 2, y + ph * 0.38, es, elastic(prog(lt, 0.9 + side * 0.25, 1)), 0, true);
      ctx.fillStyle = p.ink; ctx.textBaseline = "alphabetic";
      const f = fit(it.text, 800, Math.min(40, ph * 0.17), pw - 50, 2, 18);
      f.lines.forEach((l, li) => { ctx.textAlign = "center"; ctx.fillText(l, x + pw / 2, y + ph * 0.72 + li * f.size * 1.15); });
    });
    const vs = elastic(prog(lt, 1.2, 0.9));
    ctx.save(); ctx.translate(W / 2, top + 40 + ph / 2); ctx.scale(vs, vs); ctx.rotate(Math.sin(lt * 3) * 0.06);
    ctx.fillStyle = p.text; ctx.beginPath(); ctx.arc(0, 0, 52, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.ink; ctx.font = font(800, 38); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("VS", 0, 2);
    ctx.restore();
    ctx.globalAlpha = easeOut(prog(lt, 1.6, 0.6));
    ctx.fillStyle = p.text; ctx.textBaseline = "alphabetic";
    const sf = fit(s.subheading, 600, 30, W - 260, 1, 18);
    ctx.textAlign = "center"; ctx.fillText(sf.lines[0] || "", W / 2, top + 40 + ph + 44);
    ctx.globalAlpha = 1;
  }

  function sceneQuote(s, lt, d, p) {
    ctx.fillStyle = p.a[0];
    ctx.globalAlpha = 0.9 * easeOut(prog(lt, 0, 0.6));
    ctx.font = font(800, 300); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText("“", 110 - (1 - easeOut(prog(lt, 0, 0.8))) * 80, 330);
    ctx.globalAlpha = 1;
    emoji(s.emoji, W - 170, 160, 80, elastic(prog(lt, 0.3, 1)), Math.sin(lt * 1.5) * 0.1, true);
    // typewriter
    const f = fit(s.heading, 600, 52, W - 420, 4, 26);
    const full = f.lines.join("\n");
    const chars = Math.floor(full.length * clamp((lt - 0.4) / Math.max(1.2, Math.min(d * 0.55, full.length * 0.035))));
    let shown = full.slice(0, chars);
    ctx.fillStyle = p.text;
    const y0 = H / 2 - (f.lines.length * f.size * 1.3) / 2 + f.size * 0.6;
    shown.split("\n").forEach((l, i) => ctx.fillText(l, 220, y0 + i * f.size * 1.3));
    if (chars < full.length && Math.floor(lt * 3) % 2 === 0) {
      const last = shown.split("\n");
      const lx = 220 + ctx.measureText(last[last.length - 1]).width + 6;
      ctx.fillRect(lx, y0 + (last.length - 1) * f.size * 1.3 - f.size * 0.8, 4, f.size);
    }
    const ak = easeOut(prog(lt, 0.6 + Math.min(d * 0.55, full.length * 0.035), 0.6));
    ctx.globalAlpha = ak;
    ctx.fillStyle = p.a[1];
    roundRect(220, y0 + f.lines.length * f.size * 1.3, 50 * ak, 6, 3); ctx.fill();
    ctx.fillStyle = p.text; ctx.font = font(600, 28);
    ctx.fillText(s.subheading, 290, y0 + f.lines.length * f.size * 1.3 + 12);
    ctx.globalAlpha = 1;
  }

  function sceneOutro(s, lt, d, p) {
    // confetti
    for (let i = 0; i < 70; i++) {
      const delay = rand(i) * 0.6;
      const k = lt - delay;
      if (k < 0) continue;
      const x = W / 2 + (rand(i + 1) - 0.5) * 1400 * easeOut(k / 1.2);
      const y = 260 - 380 * easeOut(k / 0.9) * (0.5 + rand(i + 2)) + 160 * k * k;
      ctx.save(); ctx.translate(x, y); ctx.rotate(k * (2 + rand(i + 3) * 6));
      ctx.fillStyle = p.a[i % p.a.length];
      ctx.globalAlpha = clamp(1.6 - k * 0.25);
      ctx.fillRect(-7, -4, 14, 8);
      ctx.restore();
    }
    emoji(s.emoji, W / 2, 200, 120, elastic(prog(lt, 0.1, 1.1)), 0, true);
    ctx.fillStyle = p.text; ctx.textBaseline = "alphabetic";
    const f = fit(s.heading, 800, 70, W - 240, 2, 32);
    const h = kinetic(f.lines, W / 2, 360, f.size, lt, 0.4);
    const bk = easeBack(prog(lt, 1.1, 0.6));
    ctx.save(); ctx.translate(W / 2, 360 + h + 30); ctx.scale(bk, bk);
    ctx.font = font(600, 30);
    const tw = ctx.measureText(s.subheading).width + 60;
    ctx.fillStyle = p.a[0]; roundRect(-tw / 2, -32, tw, 64, 32); ctx.fill();
    ctx.fillStyle = p.ink; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(s.subheading, 0, 1);
    ctx.restore();
  }

  const SCENES = { title: sceneTitle, bullets: sceneBullets, stat: sceneStat, steps: sceneSteps,
    comparison: sceneComparison, quote: sceneQuote, outro: sceneOutro };

  // ------------------------------------------------------------------ frame
  /* Where the subtitle box sits for a scene, or null when there is none. */
  function subtitleLayout(s) {
    if (!$("subs").checked || !s.narration) return null;
    const f = fit(s.narration, 600, 26, W - 320, 3, 16);
    const lines = f.lines.slice(0, 3);
    const lh = Math.round(f.size * 1.38);
    const bh = lines.length * lh + 22;
    return { lines, lh, bh, size: f.size, y: H - bh - 34 };
  }

  function subtitles(s, lt, d, p) {
    const box = subtitleLayout(s);
    if (!box) return;
    const words = s.narration.split(/\s+/);
    const visible = Math.ceil(words.length * clamp(lt / Math.max(1, d - 0.8)));
    const { lines, lh, bh, y } = box;
    ctx.font = font(600, box.size);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 50;
    roundRect(W / 2 - bw / 2, y, bw, bh, 16); ctx.fill();
    let wi = 0;
    ctx.textBaseline = "top";
    lines.forEach((l, li) => {
      const ws = l.split(" ");
      let x = W / 2 - ctx.measureText(l).width / 2;
      ws.forEach((w) => {
        ctx.fillStyle = wi < visible ? "#ffffff" : "rgba(255,255,255,0.4)";
        ctx.textAlign = "left";
        ctx.fillText(w, x, y + 13 + li * lh);
        x += ctx.measureText(w + " ").width;
        wi++;
      });
    });
  }

  function sceneAt(time) {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > time) i--;
    return i;
  }

  function renderFrame(time) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (!board) { ctx.clearRect(0, 0, W, H); return; }
    const p = PALETTES[board.palette] || PALETTES.sunset;
    background(p, time);
    const i = sceneAt(time);
    const s = board.scenes[i];
    const lt = time - starts[i];
    const d = s.duration;
    ctx.save();
    // gentle exit: scale down and fade over the last moment
    const out = prog(lt, d - TRANS, TRANS);
    if (i < board.scenes.length - 1 && out > 0) {
      ctx.globalAlpha = 1 - out;
      ctx.translate(W / 2, H / 2); ctx.scale(1 - out * 0.08, 1 - out * 0.08); ctx.translate(-W / 2, -H / 2);
    }
    const box = subtitleLayout(s);
    safeBottom = box ? box.y - 18 : H - 30;
    (SCENES[s.type] || sceneBullets)(s, lt, d, p);
    ctx.restore();
    ctx.globalAlpha = 1;
    subtitles(s, lt, d, p);

    // wipe transition across each boundary
    const wipeIn = i < board.scenes.length - 1 ? prog(lt, d - TRANS, TRANS) : 0;
    const wipeOut = i > 0 ? prog(lt, 0, TRANS) : 1;
    ctx.fillStyle = p.a[0];
    if (wipeIn > 0) drawWipe(lerp(W + 200, 0, easeInOut(wipeIn)), p);
    if (wipeOut < 1) drawWipe(lerp(0, -W - 200, easeInOut(wipeOut)), p);

    // progress bar
    ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(0, H - 6, W, 6);
    ctx.fillStyle = p.a[1]; ctx.fillRect(0, H - 6, W * (time / total), 6);
  }

  function drawWipe(x, p) {
    ctx.save();
    ctx.translate(x, 0);
    ctx.fillStyle = p.a[1];
    ctx.beginPath(); ctx.moveTo(-60, 0); ctx.lineTo(W + 200, 0); ctx.lineTo(W + 140, H); ctx.lineTo(-120, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = p.a[0];
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W + 200, 0); ctx.lineTo(W + 140, H); ctx.lineTo(-60, H); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------------ music (WebAudio, generated)
  const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function startMusic(from, destination) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const master = ac.createGain();
    master.gain.value = 0.0001;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1800;
    master.connect(lp);
    lp.connect(ac.destination);
    let streamDest = null;
    if (destination) { streamDest = ac.createMediaStreamDestination(); lp.connect(streamDest); }
    const now = ac.currentTime + 0.05;
    const remaining = total - from;
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.5, now + 1.2);
    master.gain.setValueAtTime(0.5, now + Math.max(1.3, remaining - 2));
    master.gain.exponentialRampToValueAtTime(0.0001, now + remaining);
    const bar = 2.4, beat = bar / 4;
    const firstBar = Math.floor(from / bar);
    for (let b = firstBar; b * bar < total; b++) {
      const chord = CHORDS[b % CHORDS.length];
      const at = now + b * bar - from;
      // pad
      chord.forEach((m) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = "triangle"; o.frequency.value = hz(m);
        g.gain.setValueAtTime(0, Math.max(now, at));
        g.gain.linearRampToValueAtTime(0.06, Math.max(now, at) + 0.4);
        g.gain.linearRampToValueAtTime(0, at + bar + 0.2);
        o.connect(g); g.connect(master);
        o.start(Math.max(now, at)); o.stop(at + bar + 0.3);
      });
      for (let k = 0; k < 4; k++) {
        const bt = at + k * beat;
        if (bt < now) continue;
        // kick
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.setValueAtTime(120, bt); o.frequency.exponentialRampToValueAtTime(40, bt + 0.15);
        g.gain.setValueAtTime(0.35, bt); g.gain.exponentialRampToValueAtTime(0.001, bt + 0.2);
        o.connect(g); g.connect(master); o.start(bt); o.stop(bt + 0.22);
        // arpeggio pluck
        const n = ac.createOscillator(), ng = ac.createGain();
        n.type = "sine"; n.frequency.value = hz(chord[k % 3] + 12 + (k === 3 ? 7 : 0));
        ng.gain.setValueAtTime(0.07, bt + beat / 2); ng.gain.exponentialRampToValueAtTime(0.001, bt + beat / 2 + 0.3);
        n.connect(ng); ng.connect(master); n.start(bt + beat / 2); n.stop(bt + beat / 2 + 0.32);
      }
    }
    return { ac, stream: streamDest && streamDest.stream };
  }

  function stopMusic() {
    if (audio) { try { audio.ac.close(); } catch (e) { /* already closed */ } audio = null; }
  }

  // ------------------------------------------------------------------ voice-over (preview only)
  function speak(text) {
    if (!$("voice").checked || !("speechSynthesis" in window) || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language === "english" ? "en-US" : "hi-IN";
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------------ playback
  function layout() {
    starts = []; total = 0;
    for (const s of board.scenes) { starts.push(total); total += s.duration; }
  }

  function setTime(v) {
    t = clamp(v, 0, total);
    $("seek").value = String(Math.round((t / total) * 1000));
    $("time").textContent = `${fmt(t)} / ${fmt(total)}`;
    const i = sceneAt(t);
    document.querySelectorAll(".scene").forEach((el, k) => el.classList.toggle("active", k === i));
    renderFrame(t);
    return i;
  }

  function play() {
    if (!board) return;
    if (t >= total - 0.05) setTime(0);
    playing = true;
    playStart = performance.now() - t * 1000;
    lastScene = -1;
    $("play").textContent = "⏸ Pause";
    if ($("music").checked && !recorder) audio = startMusic(t, false);
    requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    $("play").textContent = "▶ Play";
    stopMusic();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  function tick() {
    if (!playing) return;
    const now = (performance.now() - playStart) / 1000;
    const i = setTime(now);
    if (i !== lastScene) { lastScene = i; speak(board.scenes[i].narration); }
    if (now >= total) {
      pause();
      if (recorder) setTimeout(() => recorder && recorder.state === "recording" && recorder.stop(), 250);
      return;
    }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ recording
  function pickMime() {
    const options = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  function record() {
    if (!board || recorder) return;
    if (!window.MediaRecorder || !canvas.captureStream) {
      status("This browser can't record video. Try Chrome, Edge or Firefox.", true);
      return;
    }
    pause();
    setTime(0);
    const stream = canvas.captureStream(30);
    if ($("music").checked) {
      audio = startMusic(0, true);
      audio.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    }
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 8_000_000 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      webmBlob = new Blob(chunks, { type: "video/webm" });
      const a = $("dlWebm");
      if (a.href) URL.revokeObjectURL(a.href);
      a.href = URL.createObjectURL(webmBlob);
      a.download = slug(board.title) + ".webm";
      a.classList.remove("hidden");
      if (mp4Available) $("dlMp4").classList.remove("hidden");
      recorder = null;
      stopMusic();
      $("record").disabled = false;
      $("record").textContent = "⏺ Render again";
      status("Video ready! Download it below.");
    };
    recorder.start(1000);
    $("record").disabled = true;
    $("record").textContent = "Rendering…";
    status(`Rendering ${fmt(total)} of video — keep this tab visible…`);
    play();
  }

  async function downloadMp4() {
    if (!webmBlob) return;
    const btn = $("dlMp4");
    btn.disabled = true; btn.textContent = "Converting…";
    try {
      const res = await fetch("/api/mp4", { method: "POST", body: webmBlob, headers: { "Content-Type": "video/webm" } });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = slug(board.title) + ".mp4";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      status("MP4 conversion failed: " + e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = "⬇ MP4";
    }
  }

  const slug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, "-").replace(/^-|-$/g, "") || "explainer").slice(0, 60);

  // ------------------------------------------------------------------ storyboard editor
  function renderEditor() {
    $("storyWrap").classList.remove("hidden");
    $("palette").value = board.palette;
    const ol = $("scenes");
    ol.innerHTML = "";
    board.scenes.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "scene";
      const itemsText = s.items.map((it) => `${it.emoji} ${it.text}`.trim()).join("\n");
      li.innerHTML = `
        <div class="scene-head"><span><span class="badge"></span> scene ${i + 1}</span>
          <label style="flex:none">sec <input type="number" min="3.5" max="10" step="0.5" data-k="duration"></label></div>
        <input type="text" data-k="heading" aria-label="On-screen text">
        ${s.type === "stat" ? '<input type="text" data-k="value" aria-label="Number">' : ""}
        ${s.items.length ? `<textarea rows="${s.items.length}" data-k="items" aria-label="Items, one per line"></textarea>` : ""}
        ${["title", "quote", "outro", "comparison"].includes(s.type) ? '<input type="text" data-k="subheading" aria-label="Sub-text">' : ""}
        <textarea rows="2" data-k="narration" aria-label="Narration"></textarea>`;
      li.querySelector(".badge").textContent = s.type;
      li.querySelectorAll("[data-k]").forEach((el) => {
        const k = el.dataset.k;
        el.value = k === "items" ? itemsText : s[k];
        el.addEventListener("input", () => {
          if (k === "duration") s.duration = clamp(parseFloat(el.value) || 6, 3.5, 10);
          else if (k === "items") {
            const lines = el.value.split("\n").map((l) => l.trim()).filter(Boolean);
            s.items = lines.map((l) => {
              const m = l.match(/^(\P{L}{1,4})\s+(.*)$/u);
              return m && !/^\d/.test(m[1]) ? { emoji: m[1], text: m[2] } : { emoji: "", text: l };
            });
            if (s.type === "comparison") while (s.items.length < 2) s.items.push({ emoji: "", text: "" });
          } else s[k] = el.value;
          layout();
          setTime(Math.min(t, total));
        });
        el.addEventListener("focus", () => { if (!playing) setTime(starts[i] + Math.min(s.duration - 0.6, 2.5)); });
      });
      ol.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ generation
  function status(msg, error = false) {
    const el = $("status");
    el.textContent = msg;
    el.classList.toggle("error", error);
  }

  function describeInput() {
    const v = $("input").value.trim();
    let kind = "Topic, text, or link — detected automatically.";
    if (/^https?:\/\/\S+$/i.test(v)) kind = "🔗 Web link — the page will be read and explained.";
    else if (v.length > 120 || v.includes("\n")) kind = "📝 Information — it will be turned into a video.";
    else if (v) kind = "💡 Topic — Claude will research and explain it.";
    $("inputKind").textContent = kind;
  }

  async function generate() {
    const input = $("input").value.trim();
    if (!input) { status("Type a topic, paste some information, or paste a link first.", true); return; }
    pause();
    language = $("language").value;
    $("generate").disabled = true;
    const steps = ["Reading your input…", "Writing the script…", "Designing scenes…", "Choosing animations…"];
    let n = 0;
    status(steps[0]);
    const timer = setInterval(() => status(steps[Math.min(++n, steps.length - 1)]), 4000);
    try {
      const res = await fetch("/api/storyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, language, seconds: Number($("seconds").value) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      board = data.storyboard;
      layout();
      $("empty").classList.add("hidden");
      ["play", "seek", "record"].forEach((id) => ($(id).disabled = false));
      $("dlWebm").classList.add("hidden");
      $("dlMp4").classList.add("hidden");
      webmBlob = null;
      renderEditor();
      setTime(0);
      status(`${board.scenes.length} scenes · ${fmt(total)}` + (data.engine === "offline" ? " · offline demo (add an API key for Claude)" : " · written by Claude"));
      play();
    } catch (e) {
      status(e.message, true);
    } finally {
      clearInterval(timer);
      $("generate").disabled = false;
    }
  }

  // ------------------------------------------------------------------ wiring
  let mp4Available = false;
  function init() {
    const sel = $("palette");
    Object.keys(PALETTES).forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = k; sel.appendChild(o); });
    sel.addEventListener("change", () => { board.palette = sel.value; renderFrame(t); });
    $("input").addEventListener("input", describeInput);
    $("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate(); });
    $("generate").addEventListener("click", generate);
    $("play").addEventListener("click", () => (playing ? pause() : play()));
    $("seek").addEventListener("input", (e) => {
      const was = playing; if (was) pause();
      setTime((Number(e.target.value) / 1000) * total);
      if (was) play();
    });
    $("subs").addEventListener("change", () => renderFrame(t));
    $("record").addEventListener("click", record);
    $("dlMp4").addEventListener("click", downloadMp4);
    fetch("/api/status").then((r) => r.json()).then((s) => {
      mp4Available = !!s.mp4;
      const el = $("engine");
      el.textContent = s.engine === "claude" ? `Claude · ${s.model}` : "Offline demo mode";
      el.classList.toggle("claude", s.engine === "claude");
    }).catch(() => { $("engine").textContent = "server offline"; });
    // Canvas text needs the web fonts loaded before the first frame.
    if (document.fonts) {
      Promise.all(["800 40px Poppins", "600 40px Poppins", "400 40px Poppins", '800 40px "Noto Sans Devanagari"']
        .map((f) => document.fonts.load(f, "aअ"))).catch(() => {}).then(() => board && renderFrame(t));
    }
  }

  // Expose for automated checks.
  window.explainer = {
    load(b) { board = b; layout(); $("empty").classList.add("hidden"); ["play", "seek", "record"].forEach((id) => ($(id).disabled = false)); renderEditor(); setTime(0); },
    seek: setTime,
    get total() { return total; },
  };

  init();
})();
