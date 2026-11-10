/* Explainer Studio — vertical story-reel renderer + UI.
 *
 * Draws illustrated story reels (9:16): cartoon characters in rooms, phone screens,
 * captions with highlighted words, and a closing lesson card. Every frame is a pure
 * function of time — renderFrame(t) — so preview, seeking and recording share code.
 * Voice-over clips (from /api/voice) set each scene's length and are mixed with
 * generated background music into the recording.
 */
(() => {
  "use strict";

  const W = 720, H = 1280;
  const SANS = 'Poppins, "Noto Sans Devanagari", system-ui, sans-serif';
  const SERIF = '"Playfair Display", Georgia, "Noto Sans Devanagari", serif';
  const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  const INK = "#2b211d";
  const XFADE = 0.25;
  const SKIN = { light: "#f2cba8", medium: "#d9a27c", tan: "#b97b55", dark: "#8a5a3e" };
  const CLOTH = { blue: "#5b7fb8", green: "#6b8f5e", maroon: "#8e3b46", mustard: "#d9a43a",
    teal: "#3f8f8a", purple: "#7a5aa6", grey: "#7c8088", pink: "#d9849a" };
  const HAIR = "#1f1916";

  // ------------------------------------------------------------------ state
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");
  let board = null;
  let starts = [], total = 0, t = 0;
  let playing = false, playStart = 0, lastScene = -1;
  let audio = null;       // live audio session {ac, sources, stream}
  let recorder = null, webmBlob = null;
  let status = { engine: "offline", voice: null, mp4: false };
  let voiceJob = 0;

  // ------------------------------------------------------------------ helpers
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const easeOut = (k) => 1 - Math.pow(1 - clamp(k), 3);
  const easeBack = (k) => { k = clamp(k); const c = 1.7; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
  const prog = (lt, start, dur) => clamp((lt - start) / dur);
  const rand = (s) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const font = (w, size, family = SANS) => `${w} ${size}px ${family}`;
  const castById = (id) => (board && board.cast.find((c) => c.id === id)) || (board && board.cast[0]);

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => clamp(Math.round(c + amt * 255), 0, 255);
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrap(text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  function fill(color, stroke = true, lw = 4) {
    ctx.fillStyle = color; ctx.fill();
    if (stroke) { ctx.strokeStyle = INK; ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.stroke(); }
  }

  function emoji(ch, x, y, size) {
    if (!ch) return;
    ctx.save();
    ctx.font = `${size}px ${EMOJI}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ch, x, y);
    ctx.restore();
  }

  // ------------------------------------------------------------------ rooms
  function room(setting, x0, y0, w, h, time) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    const night = setting === "night" || setting === "festive";
    const wall = { home: ["#efe2cf", "#e2cdb2"], office: ["#dfe4e6", "#c9d1d4"], night: ["#cdbfae", "#b7a690"], festive: ["#f3d9c0", "#e8c2a0"] }[setting] || ["#efe2cf", "#e2cdb2"];
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, wall[0]); g.addColorStop(1, wall[1]);
    ctx.fillStyle = g; ctx.fillRect(x0, y0, w, h);
    const lg = ctx.createRadialGradient(x0 + w * 0.25, y0 + h * 0.3, 10, x0 + w * 0.25, y0 + h * 0.3, w * 0.9);
    lg.addColorStop(0, night ? "rgba(255,220,170,0.25)" : "rgba(255,255,255,0.45)");
    lg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = lg; ctx.fillRect(x0, y0, w, h);

    // window with a city outside
    const wx = x0 + w * 0.06, wy = y0 + h * 0.16, ww = w * 0.38, wh = h * 0.3;
    const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
    if (night) { sky.addColorStop(0, "#1d2340"); sky.addColorStop(1, "#3b3560"); }
    else if (setting === "office") { sky.addColorStop(0, "#a9cbe6"); sky.addColorStop(1, "#dcecf5"); }
    else { sky.addColorStop(0, "#8f86b8"); sky.addColorStop(1, "#e7b7a3"); }
    ctx.fillStyle = sky; ctx.fillRect(wx, wy, ww, wh);
    if (night) for (let i = 0; i < 14; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.4 + 0.5 * Math.abs(Math.sin(time * 1.5 + i))})`;
      ctx.beginPath(); ctx.arc(wx + rand(i) * ww, wy + rand(i + 9) * wh * 0.6, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 6; i++) {
      const bw = ww / 6, bh = wh * (0.2 + rand(i + 3) * 0.35);
      ctx.fillStyle = night ? "#2a2847" : "#7c74a0";
      ctx.fillRect(wx + i * bw, wy + wh - bh, bw - 3, bh);
      ctx.fillStyle = night ? "#ffd98a" : "#9a92bd";
      for (let k = 0; k < 3; k++) ctx.fillRect(wx + i * bw + 6 + (k % 2) * 10, wy + wh - bh + 8 + k * 14, 4, 5);
    }
    ctx.strokeStyle = "#7a5a40"; ctx.lineWidth = 10;
    ctx.strokeRect(wx, wy, ww, wh);
    ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(wx + ww / 2, wy); ctx.lineTo(wx + ww / 2, wy + wh); ctx.stroke();
    ctx.fillStyle = "#7a5a40"; ctx.fillRect(wx - 14, wy + wh, ww + 28, 10);
    ctx.fillStyle = setting === "festive" ? "#e9a13b" : "#f4efe6";
    ctx.beginPath(); ctx.moveTo(wx + ww + 4, wy - 12); ctx.quadraticCurveTo(wx + ww + 30, wy + wh * 0.5, wx + ww + 10, wy + wh + 30);
    ctx.lineTo(wx + ww + 34, wy + wh + 30); ctx.quadraticCurveTo(wx + ww + 46, wy + wh * 0.4, wx + ww + 34, wy - 12); ctx.closePath(); ctx.fill();

    if (setting === "festive") {
      ctx.strokeStyle = "#6b5643"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, y0 + h * 0.08);
      ctx.quadraticCurveTo(x0 + w * 0.5, y0 + h * 0.16, x0 + w, y0 + h * 0.07); ctx.stroke();
      for (let i = 1; i < 14; i++) {
        const k = i / 14, lx = x0 + w * k;
        const ly = (1 - k) * (1 - k) * (y0 + h * 0.08) + 2 * (1 - k) * k * (y0 + h * 0.16) + k * k * (y0 + h * 0.07);
        const on = 0.6 + 0.4 * Math.sin(time * 3 + i);
        ctx.fillStyle = `rgba(255,${Math.round(190 + 40 * on)},90,${on})`;
        ctx.beginPath(); ctx.arc(lx, ly + 7, 6, 0, Math.PI * 2); ctx.fill();
      }
      const dx = x0 + w * 0.62, dy = y0 + h * 0.2, dw = w * 0.34;
      ctx.fillStyle = "#c7a27f"; ctx.fillRect(dx, dy, dw, h * 0.8);
      ctx.strokeStyle = "#8e6b4b"; ctx.lineWidth = 8; ctx.strokeRect(dx, dy, dw, h * 0.8);
      for (let i = 0; i < 12; i++) {
        const fx = dx + 8 + i * (dw - 16) / 11;
        ctx.fillStyle = i % 2 ? "#f29b20" : "#f7c234";
        ctx.beginPath(); ctx.arc(fx, dy + 10 + Math.sin(i) * 3, 9, 0, Math.PI * 2); ctx.fill();
        if (i % 3 === 0) { ctx.fillStyle = "#4f8a3a"; ctx.beginPath(); ctx.ellipse(fx, dy + 30, 5, 12, 0, 0, Math.PI * 2); ctx.fill(); }
      }
    } else {
      // shelf with books and a framed picture
      const sx = x0 + w * 0.6, sy = y0 + h * 0.43;
      ctx.fillStyle = "#8a6446"; ctx.fillRect(sx, sy, w * 0.42, 12);
      const books = ["#c0504d", "#4f6d9a", "#d9a43a", "#6b8f5e", "#7a5aa6", "#3f8f8a"];
      for (let i = 0; i < 6; i++) {
        const bh = 60 + rand(i + 4) * 30;
        ctx.fillStyle = books[i]; ctx.fillRect(sx + w * 0.17 + i * 22, sy - bh, 19, bh);
      }
      ctx.fillStyle = "#6e4f37"; ctx.fillRect(sx + 6, sy - 96, 78, 96);
      ctx.fillStyle = "#cfe3ef"; ctx.fillRect(sx + 14, sy - 88, 62, 80);
      ctx.fillStyle = "#8fbf73"; ctx.fillRect(sx + 14, sy - 34, 62, 26);
      ctx.fillStyle = "#c0504d"; ctx.fillRect(sx + 30, sy - 60, 9, 26);
      ctx.fillStyle = "#4f6d9a"; ctx.fillRect(sx + 50, sy - 62, 9, 28);
      if (setting === "office") {
        ctx.fillStyle = "#e8eef0"; rr(x0 + w * 0.62, y0 + h * 0.08, w * 0.3, h * 0.12, 6); ctx.fill();
        ctx.fillStyle = "#9aa6ab"; ctx.font = font(600, Math.round(h * 0.022)); ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("09:41", x0 + w * 0.77, y0 + h * 0.14);
      }
    }
    ctx.restore();
  }

  function desk(x0, y, w, bottom) {
    ctx.fillStyle = "#8a5a3a"; ctx.fillRect(x0, y, w, bottom - y);
    ctx.fillStyle = "#a06c47"; ctx.fillRect(x0, y, w, 14);
    ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.fillRect(x0, y + 14, w, 6);
  }

  // ------------------------------------------------------------------ characters
  /* Head centred at (0, -470) in character space; origin = bottom-centre of the torso. */
  function head(c, time, mood, talking, look = 0) {
    const skin = SKIN[c.skin] || SKIN.medium;
    const female = c.gender === "female";
    if (c.hair === "long") {
      ctx.beginPath();
      ctx.moveTo(-108, -500); ctx.bezierCurveTo(-140, -400, -140, -330, -120, -300);
      ctx.lineTo(120, -300); ctx.bezierCurveTo(140, -330, 140, -400, 108, -500); ctx.closePath();
      fill(HAIR);
    }
    ctx.beginPath(); rr(-30, -395, 60, 70, 10); fill(shade(skin, -0.06));
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 90, -465, 16, 26, 0, 0, Math.PI * 2); fill(skin); }
    ctx.beginPath(); ctx.ellipse(0, -470, female ? 86 : 92, female ? 104 : 108, 0, 0, Math.PI * 2); fill(skin);
    if (c.beard) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, -470, 92, 108, 0, 0.05 * Math.PI, 0.95 * Math.PI);
      ctx.ellipse(0, -445, 60, 52, 0, 0.92 * Math.PI, 0.08 * Math.PI, true);
      ctx.closePath(); ctx.fillStyle = HAIR; ctx.globalAlpha *= 0.85; ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.moveTo(-30, -424); ctx.quadraticCurveTo(0, -440, 30, -424);
      ctx.lineWidth = 9; ctx.lineCap = "round"; ctx.strokeStyle = HAIR; ctx.stroke();
    }
    // eyes (blink every few seconds)
    const blink = (time + c.id.length) % 3.7 < 0.12 ? 0.15 : 1;
    const gazeY = mood === "thinking" ? -5 : mood === "sad" ? 3 : 0;
    for (const s of [-1, 1]) {
      ctx.save(); ctx.translate(s * 36, -472); ctx.scale(1, blink);
      ctx.beginPath(); ctx.ellipse(0, 0, 17, mood === "surprised" ? 16 : 13, 0, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.beginPath(); ctx.arc(look * 5, gazeY, 9, 0, Math.PI * 2); ctx.fillStyle = "#2a1b14"; ctx.fill();
      ctx.beginPath(); ctx.arc(look * 5 + 3, gazeY - 3, 2.6, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.ellipse(s * 36, -473, 19, 15 * blink, 0, Math.PI * 1.05, Math.PI * 1.95);
      ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.stroke();
      if (female) { ctx.beginPath(); ctx.moveTo(s * 52, -480); ctx.lineTo(s * 60, -487); ctx.stroke(); }
    }
    // brows
    const tilt = { sad: -0.28, thinking: 0.12, happy: 0.05 }[mood] || 0;
    ctx.strokeStyle = HAIR; ctx.lineWidth = female ? 5 : 8; ctx.lineCap = "round";
    for (const s of [-1, 1]) {
      const lift = mood === "surprised" ? -10 : mood === "thinking" && s > 0 ? -8 : 0;
      ctx.beginPath(); ctx.moveTo(s * 18, -500 + lift + tilt * 20); ctx.lineTo(s * 54, -503 + lift - tilt * 20); ctx.stroke();
    }
    // nose
    ctx.beginPath(); ctx.moveTo(-2, -462); ctx.quadraticCurveTo(10, -440, -6, -436);
    ctx.strokeStyle = shade(skin, -0.22); ctx.lineWidth = 4; ctx.stroke();
    // mouth
    ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.fillStyle = "#7a2e2e";
    const open = talking ? 3 + 8 * Math.abs(Math.sin(time * 13)) * (0.6 + 0.4 * Math.sin(time * 5)) : 0;
    ctx.beginPath();
    if (open > 1) { ctx.ellipse(0, -414, 16, open, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    else if (mood === "happy") { ctx.moveTo(-26, -420); ctx.quadraticCurveTo(0, -394, 26, -420); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    else if (mood === "sad") { ctx.moveTo(-20, -408); ctx.quadraticCurveTo(0, -420, 20, -408); ctx.stroke(); }
    else if (mood === "surprised") { ctx.ellipse(0, -412, 10, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    else { ctx.moveTo(-18, -415); ctx.quadraticCurveTo(0, -409, 18, -415); ctx.stroke(); }
    if (female) { ctx.fillStyle = "rgba(220,90,90,0.18)"; for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 52, -440, 16, 10, 0, 0, Math.PI * 2); ctx.fill(); } }
    // hair on top
    ctx.beginPath();
    ctx.moveTo(-96, -455);
    ctx.bezierCurveTo(-112, -560, -30, -605, 20, -594);
    ctx.bezierCurveTo(92, -588, 118, -530, 96, -455);
    if (c.hair === "side_part") { ctx.bezierCurveTo(90, -520, 40, -540, -10, -528); ctx.bezierCurveTo(-60, -520, -84, -500, -96, -455); }
    else if (c.hair === "long" || c.hair === "bun") { ctx.bezierCurveTo(70, -540, 10, -548, 0, -530); ctx.bezierCurveTo(-10, -548, -70, -540, -96, -455); }
    else { ctx.bezierCurveTo(84, -505, 30, -530, -20, -515); ctx.bezierCurveTo(-60, -505, -86, -490, -96, -455); }
    ctx.closePath(); fill(HAIR, true, 3);
    if (c.hair === "curly") for (let i = 0; i < 9; i++) {
      ctx.beginPath(); ctx.arc(-88 + i * 22, -560 - Math.sin(i / 8 * Math.PI) * 38, 20, 0, Math.PI * 2); ctx.fillStyle = HAIR; ctx.fill();
    }
    if (c.hair === "bun") { ctx.beginPath(); ctx.arc(0, -600, 40, 0, Math.PI * 2); fill(HAIR, true, 3); }
  }

  function torso(c) {
    const cloth = CLOTH[c.color] || CLOTH.blue;
    const skin = SKIN[c.skin] || SKIN.medium;
    ctx.beginPath();
    ctx.moveTo(-205, 10); ctx.lineTo(-200, -250);
    ctx.quadraticCurveTo(-196, -335, -110, -342); ctx.lineTo(110, -342);
    ctx.quadraticCurveTo(196, -335, 200, -250); ctx.lineTo(205, 10); ctx.closePath();
    fill(cloth);
    if (c.outfit === "shirt") {
      ctx.beginPath(); ctx.moveTo(-42, -342); ctx.lineTo(0, -280); ctx.lineTo(42, -342); ctx.closePath(); fill(skin, false);
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(s * 72, -346); ctx.lineTo(s * 4, -282); ctx.lineTo(s * 40, -300); ctx.lineTo(s * 30, -350); ctx.closePath(); fill("#f4f1ea");
      }
      ctx.fillStyle = shade(cloth, -0.25);
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(0, -255 + i * 55, 5, 0, Math.PI * 2); ctx.fill(); }
      rr(60, -235, 62, 56, 6); ctx.strokeStyle = shade(cloth, -0.3); ctx.lineWidth = 3; ctx.stroke();
    } else if (c.outfit === "kurta" || c.outfit === "kurti") {
      ctx.beginPath(); ctx.ellipse(0, -342, 40, 16, 0, 0, Math.PI); fill(skin, false);
      rr(-44, -354, 88, 18, 8); fill(shade(cloth, -0.12));
      ctx.beginPath(); ctx.moveTo(0, -336); ctx.lineTo(0, -180); ctx.strokeStyle = shade(cloth, -0.3); ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = "#e9dcc0";
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(0, -318 + i * 36, 5, 0, Math.PI * 2); ctx.fill(); }
      if (c.outfit === "kurti") {
        ctx.beginPath(); ctx.moveTo(-180, -320); ctx.lineTo(-120, -335); ctx.lineTo(190, -40); ctx.lineTo(150, 10); ctx.closePath();
        fill(shade(cloth, 0.22), false);
      }
    } else if (c.outfit === "saree") {
      ctx.beginPath(); ctx.ellipse(0, -342, 52, 26, 0, 0, Math.PI); fill(skin, false);
      ctx.beginPath(); ctx.moveTo(-150, -342); ctx.lineTo(-60, -342); ctx.lineTo(200, -60); ctx.lineTo(200, 10); ctx.lineTo(120, 10); ctx.closePath();
      fill(shade(cloth, 0.18), false);
      ctx.beginPath(); ctx.moveTo(-60, -342); ctx.lineTo(200, -60); ctx.strokeStyle = "#e8c15a"; ctx.lineWidth = 8; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.ellipse(0, -342, 46, 24, 0, 0, Math.PI); fill(skin, false);
      ctx.beginPath(); ctx.ellipse(0, -342, 50, 28, 0, 0, Math.PI); ctx.strokeStyle = shade(cloth, -0.25); ctx.lineWidth = 6; ctx.stroke();
    }
  }

  function arm(c, pts, hand = true) {
    const cloth = CLOTH[c.color] || CLOTH.blue;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.strokeStyle = INK; ctx.lineWidth = 66; ctx.stroke();
    ctx.strokeStyle = cloth; ctx.lineWidth = 58; ctx.stroke();
    if (hand) {
      const [hx, hy] = pts[pts.length - 1];
      ctx.beginPath(); ctx.arc(hx, hy, 28, 0, Math.PI * 2); fill(SKIN[c.skin] || SKIN.medium);
    }
  }

  function phoneProp(x, y, w, h, rot) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    rr(-w / 2, -h / 2, w, h, 10); fill("#22252b");
    ctx.restore();
  }

  /* Draw a half-body character whose torso bottom sits at (x, y), scale s. */
  function character(c, x, y, s, pose, time, talking) {
    const mood = ["sad", "happy", "surprised", "thinking"].includes(pose) ? pose : "neutral";
    const bob = Math.sin(time * 1.7 + c.id.length) * 3;
    ctx.save();
    ctx.translate(x, y + bob); ctx.scale(s, s);
    const L = [[-170, -300], [-215, -140], [-120, -20]];
    const R = [[170, -300], [215, -140], [120, -20]];
    torso(c);
    if (pose === "phone_call") {
      arm(c, L);
      ctx.save(); ctx.rotate(Math.sin(time * 0.8) * 0.015); head(c, time, mood, talking); ctx.restore();
      arm(c, [[165, -300], [235, -355], [128, -430]], false);
      phoneProp(104, -470, 38, 112, 0.18);
      ctx.beginPath(); ctx.arc(124, -432, 27, 0, Math.PI * 2); fill(SKIN[c.skin] || SKIN.medium);
    } else if (pose === "holding_phone") {
      ctx.save(); ctx.translate(0, 6); head(c, time, "neutral", talking, 0); ctx.restore();
      arm(c, [[-168, -300], [-205, -150], [-50, -150]], false);
      arm(c, [[168, -300], [205, -150], [50, -150]], false);
      phoneProp(0, -195, 100, 150, 0);
      for (const s2 of [-1, 1]) { ctx.beginPath(); ctx.arc(s2 * 50, -150, 28, 0, Math.PI * 2); fill(SKIN[c.skin] || SKIN.medium); }
    } else if (pose === "thinking") {
      arm(c, L);
      head(c, time, mood, talking, 1);
      arm(c, [[165, -300], [205, -200], [40, -372]]);
    } else {
      arm(c, L); arm(c, R);
      ctx.save(); ctx.rotate(Math.sin(time * 0.7) * 0.012); head(c, time, mood, talking); ctx.restore();
    }
    ctx.restore();
  }

  /* A face inside a circle (avatars for chats, calls and the lesson card). */
  function avatar(c, x, y, r, ring = "#e8c98a") {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f6ead6"; ctx.fill();
    ctx.clip();
    if (c) {
      const s = r / 175;
      ctx.translate(x, y + r * 2.55); ctx.scale(s, s);
      torso(c); head(c, 0, "neutral", false);
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.strokeStyle = ring; ctx.lineWidth = Math.max(3, r * 0.08); ctx.stroke();
  }

  function initialsAvatar(name, x, y, r, color) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = font(700, Math.round(r * 0.9)); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((name || "?").trim().charAt(0).toUpperCase(), x, y + 1);
  }

  const castByName = (name) => board.cast.find((c) => c.name.toLowerCase() === String(name || "").toLowerCase());

  // ------------------------------------------------------------------ phone screens
  const PHW = 420, PHH = 860, PHX = (W - PHW) / 2, PHY = 300;

  function phoneFrame(lt, d, drawScreen) {
    const k = easeOut(prog(lt, 0, 0.45));
    ctx.save();
    ctx.translate(0, (1 - k) * 500 + Math.sin(lt * 1.3) * 4);
    ctx.fillStyle = "rgba(0,0,0,0.22)"; rr(PHX + 14, PHY + 22, PHW, PHH, 58); ctx.fill();
    rr(PHX, PHY, PHW, PHH, 58); ctx.fillStyle = "#16181d"; ctx.fill();
    const sx = PHX + 14, sy = PHY + 14, sw = PHW - 28, sh = PHH - 28;
    ctx.save(); rr(sx, sy, sw, sh, 46); ctx.clip();
    drawScreen(sx, sy, sw, sh);
    ctx.restore();
    ctx.fillStyle = "#16181d"; rr(W / 2 - 62, sy + 12, 124, 32, 16); ctx.fill();
    ctx.restore();
  }

  function statusBar(x, y, w, color) {
    ctx.fillStyle = color; ctx.font = font(600, 20); ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("9:41", x + 34, y + 30);
    ctx.fillRect(x + w - 74, y + 24, 30, 13);
    for (let i = 0; i < 3; i++) ctx.fillRect(x + w - 118 + i * 9, y + 36 - i * 5, 6, 6 + i * 5);
  }

  function chatScreen(p, lt, d, x, y, w, h) {
    ctx.fillStyle = "#efe7dc"; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#f7f3ee"; ctx.fillRect(x, y, w, 128);
    statusBar(x, y, w, "#222");
    ctx.strokeStyle = "#444"; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x + 32, y + 84); ctx.lineTo(x + 20, y + 96); ctx.lineTo(x + 32, y + 108); ctx.stroke();
    const contact = castByName(p.app);
    if (contact) avatar(contact, x + 72, y + 96, 26, "#d8cfc2"); else initialsAvatar(p.app, x + 72, y + 96, 26, "#3f8f8a");
    ctx.fillStyle = "#1b1b1b"; ctx.font = font(700, 23); ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(p.app || "Chat", x + 110, y + 88);
    ctx.fillStyle = "#6c6c6c"; ctx.font = font(400, 16);
    const group = p.messages.some((m) => m.sender);
    const members = [...new Set(p.messages.filter((m) => m.sender).map((m) => m.sender))].concat("You").join(", ");
    ctx.fillText(group ? members : "online", x + 110, y + 112);
    ctx.fillStyle = "#fff"; rr(x + w / 2 - 34, y + 146, 68, 26, 13); ctx.fill();
    ctx.fillStyle = "#777"; ctx.font = font(500, 14); ctx.textAlign = "center"; ctx.fillText("Today", x + w / 2, y + 160);

    // messages appear one by one; "me" messages are typed into the input bar first
    const n = p.messages.length;
    const slot = (d - 0.6) / Math.max(1, n);
    let by = y + 196;
    let typing = "";
    p.messages.forEach((m, i) => {
      const begin = 0.35 + i * slot;
      const appear = begin + (m.side === "me" ? Math.min(0.9, slot * 0.6) : 0);
      if (m.side === "me" && lt > begin && lt < appear) typing = m.text.slice(0, Math.ceil(m.text.length * prog(lt, begin, appear - begin)));
      if (lt < appear) return;
      const k = easeBack(prog(lt, appear, 0.3));
      ctx.font = font(500, 21);
      const lines = wrap(m.text, w * 0.6);
      const nameH = m.side === "them" && m.sender ? 22 : 0;
      ctx.font = font(500, 21);
      const bw = Math.max(nameH ? 90 : 0, ...lines.map((l) => ctx.measureText(l).width)) + 34;
      const bh = lines.length * 28 + 22 + nameH;
      const bx = m.side === "me" ? x + w - bw - 18 : x + 18 + (nameH ? 40 : 0);
      ctx.save(); ctx.globalAlpha *= clamp(k * 2);
      ctx.translate(bx + bw / 2, by + bh / 2); ctx.scale(lerp(0.85, 1, k), lerp(0.85, 1, k)); ctx.translate(-bx - bw / 2, -by - bh / 2);
      if (nameH) {
        const who = castByName(m.sender);
        if (who) avatar(who, x + 34, by + 18, 15, "#d8cfc2"); else initialsAvatar(m.sender, x + 34, by + 18, 15, "#7a5aa6");
      }
      ctx.fillStyle = m.side === "me" ? "#d6f3c6" : "#ffffff"; rr(bx, by, bw, bh, 14); ctx.fill();
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      if (nameH) { ctx.fillStyle = "#3f8f8a"; ctx.font = font(700, 16); ctx.fillText(m.sender, bx + 16, by + 10); }
      ctx.fillStyle = "#1b1b1b"; ctx.font = font(500, 21);
      lines.forEach((l, li) => ctx.fillText(l, bx + 16, by + 12 + nameH + li * 28));
      if (m.side === "me") { ctx.fillStyle = "#53a9e0"; ctx.font = font(600, 14); ctx.fillText("✓✓", bx + bw - 34, by + bh - 20); }
      ctx.restore();
      by += bh + 14;
    });
    // input bar
    ctx.fillStyle = "#f7f3ee"; ctx.fillRect(x, y + h - 92, w, 92);
    ctx.fillStyle = "#fff"; rr(x + 16, y + h - 76, w - 96, 52, 26); ctx.fill();
    ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = font(500, 19);
    ctx.fillStyle = typing ? "#1b1b1b" : "#9a9a9a";
    let shown = typing || "Message";
    while (typing && ctx.measureText(shown).width > w - 150) shown = shown.slice(1);
    ctx.fillText(shown + (typing && Math.floor(lt * 3) % 2 ? "|" : ""), x + 38, y + h - 50);
    ctx.beginPath(); ctx.arc(x + w - 46, y + h - 50, 26, 0, Math.PI * 2); ctx.fillStyle = "#1f8f6a"; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(x + w - 56, y + h - 62); ctx.lineTo(x + w - 32, y + h - 50); ctx.lineTo(x + w - 56, y + h - 38); ctx.closePath(); ctx.fill();
  }

  function callScreen(p, lt, d, x, y, w, h) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#22364a"); g.addColorStop(1, "#0f1820");
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    statusBar(x, y, w, "#fff");
    ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.font = font(500, 20); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Incoming call", x + w / 2, y + 150);
    const cx = x + w / 2, cy = y + 330;
    for (let i = 0; i < 3; i++) {
      const k = (lt * 0.8 + i / 3) % 1;
      ctx.beginPath(); ctx.arc(cx, cy, 90 + k * 90, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.35 * (1 - k)})`; ctx.lineWidth = 3; ctx.stroke();
    }
    const c = castByName(p.app);
    if (c) avatar(c, cx, cy, 90, "#fff"); else initialsAvatar(p.app, cx, cy, 90, "#3f8f8a");
    ctx.fillStyle = "#fff"; ctx.font = font(700, 40); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(p.app || "Unknown", cx, cy + 150);
    ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = font(400, 18); ctx.fillText("mobile", cx, cy + 188);
    const pulse = 1 + 0.06 * Math.sin(lt * 8);
    [[-1, "#e5484d", "Decline"], [1, "#2fb36a", "Accept"]].forEach(([s, col, label]) => {
      const bx = cx + s * 110, by = y + h - 170;
      ctx.save(); ctx.translate(bx, by); if (s > 0) ctx.scale(pulse, pulse);
      ctx.beginPath(); ctx.arc(0, 0, 44, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.rotate(s < 0 ? 2.4 : 0.8); ctx.fillStyle = "#fff"; rr(-20, -8, 40, 16, 8); ctx.fill();
      ctx.restore();
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.font = font(500, 17); ctx.textAlign = "center"; ctx.fillText(label, bx, by + 70);
    });
  }

  function cardScreen(p, lt, d, x, y, w, h) {
    ctx.fillStyle = "#f3f5f7"; ctx.fillRect(x, y, w, h);
    statusBar(x, y, w, "#222");
    ctx.fillStyle = "#1b1b1b"; ctx.font = font(700, 30); ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(p.app || "My App", x + 30, y + 110);
    const cy = y + 160, ch = 130 + p.lines.length * 52 + (p.button ? 80 : 0);
    const k = easeBack(prog(lt, 0.25, 0.5));
    ctx.save(); ctx.globalAlpha *= clamp(k * 2); ctx.translate(0, (1 - k) * 40);
    ctx.fillStyle = "rgba(0,0,0,0.06)"; rr(x + 22, cy + 6, w - 44, ch, 22); ctx.fill();
    ctx.fillStyle = "#fff"; rr(x + 22, cy, w - 44, ch, 22); ctx.fill();
    ctx.save(); rr(x + 22, cy, w - 44, ch, 22); ctx.clip();
    ctx.fillStyle = "#1d6f67"; ctx.fillRect(x + 22, cy, w - 44, 54);
    ctx.restore();
    ctx.fillStyle = "#fff"; ctx.font = font(600, 19); ctx.textAlign = "left"; ctx.fillText(p.title || "Details", x + 44, cy + 28);
    const ck = easeBack(prog(lt, 0.6, 0.4));
    ctx.save(); ctx.translate(x + 66, cy + 96); ctx.scale(ck, ck);
    ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fillStyle = "#2fa36b"; ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(-10, 1); ctx.lineTo(-3, 9); ctx.lineTo(11, -8); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#1b1b1b"; ctx.font = font(700, 24); ctx.fillText(p.status || "Done", x + 100, cy + 96);
    p.lines.forEach((line, i) => {
      const parts = line.split(":");
      const ly = cy + 160 + i * 52;
      ctx.fillStyle = "#e9edf0"; ctx.fillRect(x + 44, ly - 26, w - 88, 1);
      if (parts.length > 1) {
        ctx.font = font(500, 17); ctx.fillStyle = "#7a8288"; ctx.fillText(parts[0].trim(), x + 44, ly);
        ctx.fillStyle = "#1b1b1b"; ctx.font = font(600, 19); ctx.textAlign = "right"; ctx.fillText(parts.slice(1).join(":").trim(), x + w - 44, ly); ctx.textAlign = "left";
      } else { ctx.fillStyle = "#1b1b1b"; ctx.font = font(500, 19); ctx.fillText(line, x + 44, ly); }
    });
    if (p.button) {
      const by = cy + ch - 66;
      rr(x + 44, by, w - 88, 46, 12); ctx.strokeStyle = "#1d6f67"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#1d6f67"; ctx.font = font(600, 18); ctx.textAlign = "center"; ctx.fillText(p.button, x + w / 2, by + 23);
    }
    ctx.restore();
  }

  function storeScreen(p, lt, d, x, y, w, h) {
    ctx.fillStyle = "#fbf7f0"; ctx.fillRect(x, y, w, h);
    statusBar(x, y, w, "#222");
    ctx.fillStyle = "#1b1b1b"; ctx.font = font(700, 26); ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(p.app || "Store", x + 30, y + 104);
    ctx.fillStyle = "#efe6d8"; rr(x + 24, y + 140, w - 48, 330, 22); ctx.fill();
    const k = easeBack(prog(lt, 0.2, 0.6));
    ctx.save(); ctx.translate(x + w / 2, y + 305); ctx.scale(k, k); emoji(p.emoji || "🎁", 0, 0, 150); ctx.restore();
    ctx.fillStyle = "#1b1b1b"; ctx.font = font(700, 30); ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(p.title || "Product", x + 30, y + 516);
    ctx.fillStyle = "#8a8a8a"; ctx.font = font(400, 18); ctx.fillText(p.lines[0] || "", x + 30, y + 552);
    ctx.fillStyle = "#1b1b1b"; ctx.font = font(700, 30); ctx.fillText("₹", x + 30, y + 606);
    ctx.fillStyle = "#c9c2b6"; for (let i = 0; i < 5; i++) { rr(x + 58 + i * 26, y + 592, 20, 28, 6); ctx.fill(); }
    const pulse = 1 + 0.04 * Math.sin(lt * 6);
    ctx.save(); ctx.translate(x + w / 2, y + 690); ctx.scale(pulse, pulse);
    ctx.fillStyle = "#f0b93a"; rr(-(w - 60) / 2, -32, w - 60, 64, 32); ctx.fill();
    ctx.fillStyle = "#1b1b1b"; ctx.font = font(700, 22); ctx.textAlign = "center"; ctx.fillText(p.button || "Add to Cart", 0, 1);
    ctx.restore();
  }

  const SCREENS = { chat: chatScreen, call: callScreen, card: cardScreen, store: storeScreen };

  // ------------------------------------------------------------------ captions
  function captionChunks(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 10) return [words.join(" ")];
    const n = Math.ceil(words.length / 9), size = Math.ceil(words.length / n);
    const out = [];
    for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(" "));
    return out;
  }

  const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  function caption(s, lt, d, cy) {
    if (!$("subs").checked || !s.narration) return;
    const chunks = captionChunks(s.narration);
    const span = Math.max(0.5, d - 0.2) / chunks.length;
    const idx = Math.min(chunks.length - 1, Math.floor(lt / span));
    const hl = new Set((s.highlight || []).flatMap((h) => h.split(/\s+/).map(bare)).filter(Boolean));
    ctx.font = font(700, 34);
    const lines = wrap(chunks[idx], W - 150);
    const lh = 50;
    const k = easeOut(prog(lt - idx * span, 0, 0.18));
    ctx.save(); ctx.globalAlpha *= k;
    const y0 = cy - (lines.length * lh) / 2;
    lines.forEach((line, li) => {
      const lw = ctx.measureText(line).width;
      const ly = y0 + li * lh;
      ctx.fillStyle = "rgba(43,30,52,0.86)"; rr(W / 2 - lw / 2 - 14, ly, lw + 28, lh - 4, 10); ctx.fill();
      let x = W / 2 - lw / 2;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      line.split(" ").forEach((w) => {
        ctx.fillStyle = hl.has(bare(w)) ? "#ffcf5a" : "#ffffff";
        ctx.fillText(w, x, ly + lh / 2 - 1);
        x += ctx.measureText(w + " ").width;
      });
    });
    ctx.restore();
  }

  // ------------------------------------------------------------------ scenes
  function sceneCharacter(s, lt, d, time) {
    const c = castById(s.character);
    const zoom = 1 + 0.035 * clamp(lt / d);
    ctx.save(); ctx.translate(W / 2, H * 0.55); ctx.scale(zoom, zoom); ctx.translate(-W / 2, -H * 0.55);
    room(s.setting, 0, 0, W, H, time);
    character(c, W / 2, H * 0.8, 1.02, s.pose, time, s.speaker === c.id);
    desk(0, H * 0.8, W, H);
    ctx.restore();
    caption(s, lt, d, H * 0.735);
  }

  function sceneTwo(s, lt, d, time) {
    const a = castById(s.character), b = castById(s.other_character);
    room(s.setting, 0, 0, W, H / 2, time);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H / 2); ctx.clip();
    character(a, W / 2, H * 0.47, 0.72, "phone_call", time, s.speaker === a.id);
    desk(0, H * 0.47, W, H / 2);
    ctx.restore();
    const k = easeOut(prog(lt, 0, 0.4));
    ctx.save(); ctx.translate(0, (1 - k) * H * 0.5);
    room(s.other_setting, 0, H / 2, W, H / 2, time);
    ctx.save(); ctx.beginPath(); ctx.rect(0, H / 2, W, H / 2); ctx.clip();
    character(b, W / 2, H * 1.0, 0.8, "phone_call", time, s.speaker === b.id);
    ctx.restore();
    ctx.fillStyle = INK; ctx.fillRect(0, H / 2 - 3, W, 6);
    ctx.restore();
    caption(s, lt, d, H * 0.42);
  }

  function scenePhone(s, lt, d, time) {
    ctx.save(); ctx.filter = "blur(7px)"; room(s.setting, -20, -20, W + 40, H + 40, time); ctx.restore();
    ctx.fillStyle = "rgba(60,40,30,0.18)"; ctx.fillRect(0, 0, W, H);
    const p = s.phone;
    phoneFrame(lt, d, (x, y, w, h) => (SCREENS[p.screen] || cardScreen)(p, lt, d, x, y, w, h));
    caption(s, lt, d, 190);
  }

  function scenePhoto(s, lt, d, time) {
    const [a, b] = board.cast;
    ctx.save(); ctx.filter = "blur(5px)"; room(s.setting, -20, -20, W + 40, H + 40, time); ctx.restore();
    ctx.fillStyle = "rgba(240,225,200,0.35)"; ctx.fillRect(0, 0, W, H);
    const k = easeOut(prog(lt, 0, 0.6));
    ctx.save(); ctx.translate(W / 2, H * 0.45); ctx.rotate(-0.06 + (1 - k) * 0.2); ctx.scale(lerp(0.85, 1, k), lerp(0.85, 1, k));
    const fw = 520, fh = 640;
    ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(-fw / 2 + 16, -fh / 2 + 20, fw, fh);
    ctx.fillStyle = "#6e4a30"; ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
    ctx.fillStyle = "#f4ead8"; ctx.fillRect(-fw / 2 + 26, -fh / 2 + 26, fw - 52, fh - 52);
    ctx.save(); ctx.beginPath(); ctx.rect(-fw / 2 + 44, -fh / 2 + 44, fw - 88, fh - 88); ctx.clip();
    const sky = ctx.createLinearGradient(0, -fh / 2, 0, fh / 2);
    sky.addColorStop(0, "#bfe0f0"); sky.addColorStop(1, "#eaf4f2");
    ctx.fillStyle = sky; ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
    ctx.fillStyle = "#f4e27a"; ctx.beginPath(); ctx.arc(140, -200, 40, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#8fbf73"; ctx.fillRect(-fw / 2, 120, fw, fh);
    character(a, -100, 280, 0.52, "happy", time, false);
    character(b, 100, 280, 0.52, "happy", time, false);
    ctx.fillStyle = "rgba(255,230,180,0.16)"; ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
    ctx.restore();
    ctx.restore();
    caption(s, lt, d, H * 0.86);
  }

  function sceneLesson(s, lt, d, time) {
    const g = ctx.createRadialGradient(W / 2, H * 0.45, 40, W / 2, H * 0.45, H * 0.75);
    g.addColorStop(0, "#5a2d9a"); g.addColorStop(1, "#2b1350");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    rr(34, 60, W - 68, H - 120, 26); ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 2; ctx.stroke();
    const title = s.lesson.heading || s.lesson.book || board.title;
    const k = easeOut(prog(lt, 0, 0.7));
    const ty = H * 0.17;
    ctx.save(); ctx.globalAlpha *= k;
    ctx.strokeStyle = "rgba(232,201,138,0.8)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W / 2 - 110 * k, ty); ctx.lineTo(W / 2 + 110 * k, ty); ctx.stroke();
    ctx.fillStyle = "#e8c98a"; ctx.beginPath(); ctx.arc(W / 2, ty, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = font(500, 54, SERIF); ctx.textAlign = "center"; ctx.textBaseline = "top";
    const lines = wrap(title, W - 160).slice(0, 3);
    lines.forEach((l, i) => ctx.fillText(l, W / 2, ty + 30 + i * 66));
    const end = ty + 30 + lines.length * 66 + 22;
    ctx.beginPath(); ctx.moveTo(W / 2 - 110 * k, end); ctx.lineTo(W / 2 + 110 * k, end); ctx.stroke();
    ctx.restore();
    const people = board.cast.slice(0, 2);
    const ay = H * 0.53;
    if (people.length === 2) {
      const lk = easeOut(prog(lt, 0.6, 0.8));
      ctx.strokeStyle = "#e8c98a"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(W / 2 - 75, ay); ctx.lineTo(W / 2 - 75 + 150 * lk, ay); ctx.stroke();
      people.forEach((c, i) => {
        const pk = easeBack(prog(lt, 0.3 + i * 0.2, 0.5));
        ctx.save(); ctx.translate(W / 2 + (i ? 165 : -165), ay); ctx.scale(pk, pk); avatar(c, 0, 0, 92); ctx.restore();
      });
    } else if (people.length === 1) {
      const pk = easeBack(prog(lt, 0.3, 0.5));
      ctx.save(); ctx.translate(W / 2, ay); ctx.scale(pk, pk); avatar(people[0], 0, 0, 110); ctx.restore();
    }
    caption(s, lt, d, H * 0.8);
  }

  const SCENES = { character: sceneCharacter, two_characters: sceneTwo, phone: scenePhone, photo: scenePhoto, lesson: sceneLesson };

  // ------------------------------------------------------------------ frame
  function sceneAt(time) {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > time) i--;
    return i;
  }

  function drawScene(i, lt, time) {
    const s = board.scenes[i];
    ctx.save();
    (SCENES[s.visual] || sceneCharacter)(s, lt, s.duration, time);
    ctx.restore();
  }

  function renderFrame(time) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.filter = "none";
    if (!board) { ctx.fillStyle = "#1a1720"; ctx.fillRect(0, 0, W, H); return; }
    const i = sceneAt(time), lt = time - starts[i];
    if (i > 0 && lt < XFADE) {
      drawScene(i - 1, board.scenes[i - 1].duration, time);
      ctx.globalAlpha = lt / XFADE;
    }
    drawScene(i, lt, time);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(0, H - 5, W * (time / total), 5);
  }

  // ------------------------------------------------------------------ audio
  const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function scheduleMusic(ac, out, from, now) {
    const bus = ac.createGain();
    const level = board.scenes.some((s) => s._buffer) ? 0.16 : 0.32;
    const left = total - from;
    bus.gain.setValueAtTime(0.0001, now);
    bus.gain.exponentialRampToValueAtTime(level, now + 1);
    bus.gain.setValueAtTime(level, now + Math.max(1.1, left - 1.5));
    bus.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(1.2, left + 0.3));
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1400;
    bus.connect(lp); lp.connect(out);
    const bar = 3.2;
    for (let b = Math.floor(from / bar); b * bar < total; b++) {
      const at = now + b * bar - from, chord = CHORDS[b % 4];
      chord.forEach((m) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = "triangle"; o.frequency.value = hz(m - 12);
        const st = Math.max(now, at);
        g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(0.08, st + 0.6); g.gain.linearRampToValueAtTime(0, at + bar + 0.3);
        o.connect(g); g.connect(bus); o.start(st); o.stop(at + bar + 0.4);
      });
      for (let k = 0; k < 4; k++) {
        const bt = at + k * (bar / 4) + bar / 8;
        if (bt < now) continue;
        const n = ac.createOscillator(), ng = ac.createGain();
        n.type = "sine"; n.frequency.value = hz(chord[(k + b) % 3] + 12);
        ng.gain.setValueAtTime(0.05, bt); ng.gain.exponentialRampToValueAtTime(0.001, bt + 0.5);
        n.connect(ng); ng.connect(bus); n.start(bt); n.stop(bt + 0.55);
      }
    }
  }

  /* Start music and every voice clip from `from` seconds, in sync with the visuals. */
  function startAudio(from, record) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const out = ac.createGain();
    out.connect(ac.destination);
    let stream = null;
    if (record) { const dest = ac.createMediaStreamDestination(); out.connect(dest); stream = dest.stream; }
    const now = ac.currentTime + 0.08;
    if ($("music").checked) scheduleMusic(ac, out, from, now);
    board.scenes.forEach((s, i) => {
      if (!s._buffer) return;
      const at = starts[i] + 0.15 - from;
      if (at + s._buffer.duration <= 0) return;
      const src = ac.createBufferSource();
      src.buffer = s._buffer; src.connect(out);
      if (at >= 0) src.start(now + at); else src.start(now, -at);
    });
    return { ac, stream };
  }

  function stopAudio() {
    if (audio) { try { audio.ac.close(); } catch (e) { /* already closed */ } audio = null; }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  function browserSpeak(s) {
    if (!$("voice").checked || s._buffer || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s.narration);
    u.lang = board.language === "english" ? "en-IN" : "hi-IN";
    speechSynthesis.speak(u);
  }

  function roleOf(s) {
    if (s.speaker === "narrator") return "narrator";
    const c = board.cast.find((m) => m.id === s.speaker);
    return c ? c.gender : "narrator";
  }

  const voiceKey = (s) => s.narration + "|" + roleOf(s);
  const estimate = (text) => Math.min(9, Math.max(2.2, 0.9 + text.split(/\s+/).filter(Boolean).length * 0.42));

  async function fetchVoices() {
    if (!status.voice || !board) return;
    const job = ++voiceJob;
    const need = board.scenes.filter((s) => s._voiceFor !== voiceKey(s));
    if (!need.length) return;
    const decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
    let done = 0, failed = null;
    say(`Voice-over bana rahe hain… 0/${need.length}`);
    const queue = need.slice();
    const worker = async () => {
      while (queue.length && job === voiceJob) {
        const s = queue.shift();
        const key = voiceKey(s);
        try {
          const res = await fetch("/api/voice", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: s.narration.replace(/[“”"]/g, ""), role: roleOf(s), language: board.language }),
          });
          if (!res.ok) throw new Error((await res.json()).error || res.statusText);
          const buf = await decoder.decodeAudioData(await res.arrayBuffer());
          if (job !== voiceJob) return;
          if (voiceKey(s) === key) { s._buffer = buf; s._voiceFor = key; s.duration = Math.max(1.6, buf.duration + 0.45); }
        } catch (e) { failed = e.message; }
        done++;
        say(`Voice-over bana rahe hain… ${done}/${need.length}`);
      }
    };
    await Promise.all([worker(), worker()]);  // free TTS plans allow few requests at once
    if (job !== voiceJob) return;
    layout(); setTime(Math.min(t, total));
    say(failed ? `Kuch voice clips nahi bane: ${failed}` : `${board.scenes.length} scenes · ${fmt(total)} · AI voice-over ready`, !!failed);
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

  function play(record = false) {
    if (!board) return null;
    if (t >= total - 0.05) setTime(0);
    playing = true;
    audio = startAudio(t, record);
    playStart = performance.now() - t * 1000;
    lastScene = -1;
    $("play").textContent = "⏸ Pause";
    requestAnimationFrame(tick);
    return audio;
  }

  function pause() {
    playing = false;
    $("play").textContent = "▶ Play";
    stopAudio();
  }

  function tick() {
    if (!playing) return;
    const now = (performance.now() - playStart) / 1000;
    const i = setTime(now);
    if (i !== lastScene) { lastScene = i; browserSpeak(board.scenes[i]); }
    if (now >= total) {
      if (recorder) setTimeout(() => { if (recorder && recorder.state === "recording") recorder.stop(); stopAudio(); }, 300);
      playing = false; $("play").textContent = "▶ Play";
      if (!recorder) stopAudio();
      return;
    }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ recording
  function pickMime() {
    const options = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  async function record() {
    if (!board || recorder) return;
    if (!window.MediaRecorder || !canvas.captureStream) { say("Ye browser video record nahi kar sakta. Chrome, Edge ya Firefox try karo.", true); return; }
    pause();
    await fetchVoices();
    setTime(0);
    const stream = canvas.captureStream(30);
    const chunks = [];
    const session = play(true);
    session.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    recorder = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 7_000_000 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      webmBlob = new Blob(chunks, { type: "video/webm" });
      const a = $("dlWebm");
      if (a.href) URL.revokeObjectURL(a.href);
      a.href = URL.createObjectURL(webmBlob);
      a.download = slug(board.title) + ".webm";
      a.classList.remove("hidden");
      if (status.mp4) $("dlMp4").classList.remove("hidden");
      recorder = null;
      $("record").disabled = false; $("record").textContent = "⏺ Render again";
      say("Video ready! Neeche se download karo.");
    };
    recorder.start(1000);
    $("record").disabled = true; $("record").textContent = "Rendering…";
    say(`Rendering ${fmt(total)} — ye tab khula aur visible rakho…`);
  }

  async function downloadMp4() {
    if (!webmBlob) return;
    const btn = $("dlMp4");
    btn.disabled = true; btn.textContent = "Converting…";
    try {
      const res = await fetch("/api/mp4", { method: "POST", body: webmBlob, headers: { "Content-Type": "video/webm" } });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = slug(board.title) + ".mp4";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      say("MP4 conversion failed: " + e.message, true);
    } finally { btn.disabled = false; btn.textContent = "⬇ MP4"; }
  }

  const slug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, "-").replace(/^-|-$/g, "") || "story").slice(0, 60);

  // ------------------------------------------------------------------ storyboard editor
  const VISUAL_LABEL = { character: "Character", two_characters: "Call (split)", phone: "Phone", photo: "Photo", lesson: "Lesson card" };

  function phoneText(p) {
    if (p.screen === "chat") return p.messages.map((m) => `${m.side === "me" ? "me" : m.sender || "them"}: ${m.text}`).join("\n");
    if (p.screen === "card") return [p.title, p.status, ...p.lines].join("\n");
    if (p.screen === "store") return [p.title, p.lines[0] || ""].join("\n");
    return p.app;
  }

  function applyPhoneText(p, value) {
    const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (p.screen === "chat") {
      p.messages = lines.map((l) => {
        const m = l.match(/^([^:]{1,20}):\s*(.*)$/);
        if (!m) return { side: "them", sender: "", text: l };
        if (m[1].toLowerCase() === "me") return { side: "me", sender: "", text: m[2] };
        return { side: "them", sender: m[1].toLowerCase() === "them" ? "" : m[1], text: m[2] };
      });
    } else if (p.screen === "card") { p.title = lines[0] || ""; p.status = lines[1] || ""; p.lines = lines.slice(2, 5); }
    else if (p.screen === "store") { p.title = lines[0] || ""; p.lines = lines.slice(1, 2); }
    else p.app = lines[0] || "";
  }

  function renderEditor() {
    $("storyWrap").classList.remove("hidden");
    const ol = $("scenes");
    ol.innerHTML = "";
    board.scenes.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "scene";
      const who = s.speaker === "narrator" ? "narrator" : (castById(s.speaker) || {}).name;
      li.innerHTML = `
        <div class="scene-head"><span><span class="badge"></span> ${i + 1}</span><span class="muted who"></span></div>
        <textarea rows="2" data-k="narration" aria-label="Caption / narration"></textarea>
        <input type="text" data-k="highlight" aria-label="Highlighted words" placeholder="highlight words (comma se alag)">
        ${s.visual === "phone" ? '<textarea rows="3" data-k="phone" aria-label="Phone screen text"></textarea>' : ""}
        ${s.visual === "lesson" ? '<input type="text" data-k="heading" aria-label="Lesson card title">' : ""}`;
      li.querySelector(".badge").textContent = s.visual === "phone" ? `Phone · ${s.phone.screen}` : VISUAL_LABEL[s.visual];
      const meta = li.querySelector(".who");
      const showMeta = () => { meta.textContent = `${who} · ${s.duration.toFixed(1)}s`; };
      showMeta();
      li.querySelectorAll("[data-k]").forEach((el) => {
        const k = el.dataset.k;
        el.value = k === "highlight" ? s.highlight.join(", ") : k === "phone" ? phoneText(s.phone) : k === "heading" ? s.lesson.heading : s[k];
        el.addEventListener("input", () => {
          if (k === "narration") {
            s.narration = el.value;
            if (s._voiceFor !== voiceKey(s)) { s._buffer = null; s.duration = estimate(s.narration); }
            showMeta();
          } else if (k === "highlight") s.highlight = el.value.split(",").map((x) => x.trim()).filter(Boolean);
          else if (k === "phone") applyPhoneText(s.phone, el.value);
          else if (k === "heading") s.lesson.heading = el.value;
          layout(); setTime(Math.min(t, total));
        });
        el.addEventListener("focus", () => { if (!playing) setTime(starts[i] + Math.min(s.duration - 0.3, 1.2)); });
      });
      ol.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ generation
  function say(msg, error = false) {
    const el = $("status");
    el.textContent = msg;
    el.classList.toggle("error", error);
  }

  function describeInput() {
    const v = $("input").value.trim();
    let kind = "Topic, text, ya link — apne aap pehchaan lega.";
    if (/^https?:\/\/\S+$/i.test(v)) kind = "🔗 Web link — page padh ke uski kahani banegi.";
    else if (v.length > 120 || v.includes("\n")) kind = "📝 Information — isse kahani banegi.";
    else if (v) kind = "💡 Topic — Claude iski ek kahani likhega.";
    $("inputKind").textContent = kind;
  }

  function loadBoard(b) {
    board = b;
    board.language = board.language || $("language").value;
    layout();
    $("empty").classList.add("hidden");
    ["play", "seek", "record"].forEach((id) => ($(id).disabled = false));
    $("dlWebm").classList.add("hidden"); $("dlMp4").classList.add("hidden");
    webmBlob = null;
    renderEditor();
    setTime(0);
  }

  async function generate() {
    const input = $("input").value.trim();
    if (!input) { say("Pehle koi topic likho, information paste karo, ya link do.", true); return; }
    pause();
    $("generate").disabled = true;
    const steps = ["Input padh rahe hain…", "Kahani soch rahe hain…", "Characters bana rahe hain…", "Scenes likh rahe hain…"];
    let n = 0;
    say(steps[0]);
    const timer = setInterval(() => say(steps[Math.min(++n, steps.length - 1)]), 5000);
    try {
      const res = await fetch("/api/storyboard", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, language: $("language").value, seconds: Number($("seconds").value) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      clearInterval(timer);
      loadBoard(data.storyboard);
      say(`${board.scenes.length} scenes · ${fmt(total)}` + (data.engine === "offline" ? " · offline demo (Claude ke liye API key lagao)" : " · Claude ne likha"));
      await fetchVoices();
      renderEditor(); setTime(0);
      play();
    } catch (e) {
      say(e.message, true);
    } finally {
      clearInterval(timer);
      $("generate").disabled = false;
    }
  }

  // ------------------------------------------------------------------ wiring
  function init() {
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
    $("revoice").addEventListener("click", async () => { pause(); await fetchVoices(); renderEditor(); setTime(0); });
    fetch("/api/status").then((r) => r.json()).then((s) => {
      status = s;
      const el = $("engine");
      el.textContent = (s.engine === "claude" ? `Claude · ${s.model}` : "Offline demo") + (s.voice ? ` · voice: ${s.voice}` : " · no AI voice");
      el.classList.toggle("claude", s.engine === "claude");
      $("voiceNote").textContent = s.voice
        ? `AI voice-over (${s.voice}) har scene ke liye banega aur video mein record hoga.`
        : "AI voice ke liye server par ELEVENLABS_API_KEY ya OPENAI_API_KEY set karo. Tab tak video mein captions + music honge.";
      $("revoice").classList.toggle("hidden", !s.voice);
      $("voiceLabel").classList.toggle("hidden", !!s.voice);
    }).catch(() => { $("engine").textContent = "server offline"; });
    if (document.fonts) {
      Promise.all(["700 34px Poppins", "600 20px Poppins", '500 54px "Playfair Display"', '700 34px "Noto Sans Devanagari"']
        .map((f) => document.fonts.load(f, "aअ"))).catch(() => {}).then(() => renderFrame(t));
    }
    renderFrame(0);
  }

  // Exposed for automated checks.
  window.explainer = { load: loadBoard, seek: setTime, get total() { return total; } };

  init();
})();
