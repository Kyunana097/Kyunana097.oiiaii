/* ============================================================================
   打砖块 · NEON
   Canvas + 原生 JS，无依赖。
   设计参考：Arkanoid (1986) 的胶囊道具与霓虹配色、Shatter (2009) 的吸/斥磁场、
   经典打砖块的挡板角度反射；物理用最小穿透反弹 + 子步进防隧穿。
   核心循环：连击 → 充能 → 磁场（吸/斥）与慢动作 → 更容易维持连击。
   ========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 常量
  var W = 800, H = 600;                 // 逻辑分辨率（4:3）
  var WALL = 10;                        // 左右上三面墙的厚度
  var FIXED = 1 / 120;                  // 物理固定步长（秒）
  var MAX_FRAME = 0.05;                 // 单帧最大推进时间，防止切后台回来穿墙
  var MAX_BALLS = 8;
  var COLORS = ['#ff4e6a', '#ff761e', '#ffb900', '#33d57a', '#00dbff', '#1a98ff', '#9090ff'];
  var COLS = 12, CELL_W = (W - WALL * 2) / COLS, CELL_H = 30, BRICK_H = 24, GRID_TOP = 74;
  var PADDLE_Y = H - 44, PADDLE_H = 14, PADDLE_W = 112;
  var BALL_R = 8;
  var BASE_SPEED = 380, SPEED_PER_LEVEL = 14, SPEED_MAX = 640;
  var ENERGY_MAX = 100, ENERGY_REGEN = 9, ENERGY_PER_HIT = 3.2;
  var DRAIN_MAGNET = 30, DRAIN_SLOW = 22;
  var MAGNET_ACC = 1250, REPEL_ACC = 1500;
  var SLOW_SCALE = 0.45;
  var COMBO_TIMEOUT = 3.5;
  var POWER_TIME = 14;
  var BEST_KEY = 'breakout.neon.best', MUTE_KEY = 'breakout.neon.mute';

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rnd = Math.random;

  // ---------------------------------------------------------------- 关卡
  // . 空 | 1-7 普通砖（颜色） | A 装甲砖（3 击） | X 钢砖（打不烂）
  // B 炸弹砖（炸周围一圈） | M 漂移砖 | G 必掉道具的普通砖
  var LEVELS = [
    { name: '彩虹', rows: [
      '111111111111',
      '222222222222',
      '333333333333'
    ]},
    { name: '阶梯', rows: [
      '1...........',
      '22..........',
      '333.........',
      '4444........',
      '55555.......',
      '666666......',
      '7777777.....'
    ]},
    { name: '小堡垒', rows: [
      '.XX......XX.',
      '.X........X.',
      '.X.3A44A3.X.',
      '.X.4G11G4.X.',
      '.X.3A44A3.X.',
      '.X........X.',
      '.XX......XX.'
    ]},
    { name: '棋盘', rows: [
      '222222222222',
      '.3.3.3.3.3.3',
      '4A4A4A4A4A4A',
      '.5.5.5.5.5.5',
      '666666666666'
    ]},
    { name: '双塔', rows: [
      '111......111',
      '1A1..GG..1A1',
      '111......111',
      '.X........X.',
      '..5......5..',
      '...6....6...',
      '....7777....'
    ]},
    { name: '炸弹阵', rows: [
      '.2.2.2.2.2.2',
      '2B2B2B2B2B2B',
      'M3M3M3M3M3M3',
      '44G4444G4444'
    ]},
    { name: '钻石', rows: [
      '.....GG.....',
      '....3AA3....',
      '...3A44A3...',
      '..3A4GG4A3..',
      '.3A4G11G4A3.',
      '3A4G1221G4A3'
    ]},
    { name: '长城', rows: [
      '.X.X.X.X.X.X',
      'AAAAAAAAAAAA',
      '1A1A1A1A1A1A',
      'G1111111111G',
      '111111111111'
    ]}
  ];

  function parseLevel(rows) {
    var bricks = [];
    for (var r = 0; r < rows.length; r++) {
      var line = rows[r];
      for (var c = 0; c < COLS; c++) {
        var ch = line.charAt(c) || '.';
        if (ch === '.') continue;
        var x = WALL + c * CELL_W + 2;
        var y = GRID_TOP + r * CELL_H;
        var b = {
          x: x, y: y, w: CELL_W - 4, h: BRICK_H,
          kind: 'normal', hp: 1, alive: true, flash: 0, drop: false,
          color: COLORS[c % COLORS.length], drift: 0, dir: 1, baseX: x, range: 0
        };
        if (ch >= '1' && ch <= '7') {
          b.color = COLORS[(parseInt(ch, 10) - 1) % COLORS.length];
        } else if (ch === 'A') {
          b.kind = 'armor'; b.hp = 3; b.color = '#c9d4ee';
        } else if (ch === 'X') {
          b.kind = 'steel'; b.hp = Infinity; b.color = '#5b6478';
        } else if (ch === 'B') {
          b.kind = 'bomb'; b.hp = 1; b.color = '#ff4e6a';
        } else if (ch === 'M') {
          b.kind = 'move'; b.hp = 1; b.color = COLORS[(r + 4) % COLORS.length];
          b.range = CELL_W * 0.42; b.dir = (r % 2 ? 1 : -1);
        } else if (ch === 'G') {
          b.kind = 'gift'; b.hp = 1; b.drop = true; b.color = '#ffe89a';
        }
        bricks.push(b);
      }
    }
    return bricks;
  }

  function endlessRows(n) {
    var rows = [];
    var count = 4 + Math.min(4, Math.floor(n / 3));
    for (var r = 0; r < count; r++) {
      var line = '';
      for (var c = 0; c < COLS; c++) {
        var roll = rnd();
        if (roll < 0.12 && n > 2) line += 'X';
        else if (roll < 0.22 && n > 1) line += 'A';
        else if (roll < 0.28) line += 'M';
        else if (roll < 0.33) line += 'B';
        else if (roll < 0.37) line += 'G';
        else if (roll < 0.46) line += '.';
        else line += String(1 + Math.floor(rnd() * Math.min(7, 2 + Math.floor(n / 2))));
      }
      rows.push(line);
    }
    return rows;
  }

  // ---------------------------------------------------------------- 音效
  var Sound = (function () {
    var ctx = null, muted = false, silent = false;
    try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { muted = false; }

    function ac() {
      if (ctx) return ctx;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { ctx = null; }
      return ctx;
    }
    function tone(freq, dur, type, gain, slide) {
      if (muted || silent) return;
      var a = ac(); if (!a) return;
      if (a.state === 'suspended') { try { a.resume(); } catch (e) {} }
      var t0 = a.currentTime;
      var osc = a.createOscillator(), g = a.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.06, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(a.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    function noise(dur, gain) {
      if (muted || silent) return;
      var a = ac(); if (!a) return;
      var len = Math.floor(a.sampleRate * dur);
      var buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = a.createBufferSource(); src.buffer = buf;
      var g = a.createGain(); g.gain.value = gain || 0.07;
      var f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400;
      src.connect(f); f.connect(g); g.connect(a.destination); src.start();
    }
    return {
      setSilent: function (v) { silent = !!v; },
      unlock: function () { var a = ac(); if (a && a.state === 'suspended') { try { a.resume(); } catch (e) {} } },
      isMuted: function () { return muted; },
      setMuted: function (m) {
        muted = !!m;
        try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
      },
      brick: function (combo) { tone(300 * Math.pow(2, Math.min(24, combo) / 12), 0.07, 'square', 0.05); },
      break_: function () { noise(0.09, 0.05); },
      armor: function () { tone(180, 0.09, 'sawtooth', 0.045, 120); },
      steel: function () { tone(900, 0.045, 'triangle', 0.035, 640); },
      paddle: function () { tone(150, 0.08, 'square', 0.05, 110); },
      wall: function () { tone(520, 0.03, 'triangle', 0.025); },
      power: function () {
        [0, 4, 7, 12].forEach(function (s, i) {
          setTimeout(function () { tone(440 * Math.pow(2, s / 12), 0.1, 'triangle', 0.05); }, i * 55);
        });
      },
      lose: function () { tone(320, 0.5, 'sawtooth', 0.06, 70); },
      clear: function () {
        [0, 5, 9, 12, 16].forEach(function (s, i) {
          setTimeout(function () { tone(392 * Math.pow(2, s / 12), 0.16, 'square', 0.05); }, i * 90);
        });
      },
      magnet: function () { tone(90, 0.12, 'sine', 0.03, 60); }
    };
  })();

  // ---------------------------------------------------------------- 世界
  var POWER_TYPES = {
    multi:  { icon: '⚡', label: '多球',   color: '#00dbff', weight: 18 },
    wide:   { icon: '↔', label: '加宽',   color: '#33d57a', weight: 18 },
    laser:  { icon: '▲', label: '激光',   color: '#ff4e6a', weight: 16 },
    sticky: { icon: '✋', label: '粘性',   color: '#ffb900', weight: 13 },
    slow:   { icon: '⏳', label: '慢动作', color: '#9090ff', weight: 14 },
    double: { icon: '★', label: '双倍分', color: '#ff761e', weight: 13 },
    life:   { icon: '♥', label: '加命',   color: '#ff4e6a', weight: 8 }
  };
  var POWER_KEYS = Object.keys(POWER_TYPES);

  function pickPower() {
    var total = 0, i;
    for (i = 0; i < POWER_KEYS.length; i++) total += POWER_TYPES[POWER_KEYS[i]].weight;
    var roll = rnd() * total;
    for (i = 0; i < POWER_KEYS.length; i++) {
      roll -= POWER_TYPES[POWER_KEYS[i]].weight;
      if (roll <= 0) return POWER_KEYS[i];
    }
    return 'multi';
  }

  function baseSpeed(level) {
    return Math.min(SPEED_MAX * 0.82, BASE_SPEED + (level - 1) * SPEED_PER_LEVEL);
  }

  function createWorld(opts) {
    opts = opts || {};
    var w = {
      isMain: !!opts.main,
      endless: !!opts.endless,
      level: opts.level || 1,
      balls: [], bricks: [], powerups: [], lasers: [], particles: [], pops: [],
      paddle: { x: W / 2, y: PADDLE_Y, w: PADDLE_W, h: PADDLE_H, vx: 0, targetX: W / 2, glow: 0 },
      score: 0, lives: 3, combo: 0, bestCombo: 0, comboClock: 0,
      energy: ENERGY_MAX, effects: {},
      breakable: 0, remaining: 0, totalBreakable: 0,
      time: 0, shake: 0, flash: 0, over: false, cleared: false,
      stats: { paddle: 0, wall: 0, dmg: 0, life: 0 },
      shotTimer: 0, laserTimer: 0
    };
    buildLevel(w, w.level);
    return w;
  }

  function buildLevel(w, level) {
    var rows;
    if (w.endless && level > LEVELS.length) rows = endlessRows(level - LEVELS.length);
    else rows = LEVELS[(level - 1) % LEVELS.length].rows;
    w.bricks = parseLevel(rows);
    w.breakable = 0;
    for (var i = 0; i < w.bricks.length; i++) if (w.bricks[i].kind !== 'steel') w.breakable++;
    w.totalBreakable = w.breakable;
    w.remaining = w.breakable;
    w.powerups.length = 0; w.lasers.length = 0; w.particles.length = 0;
    w.effects = {};
    resetBall(w);
  }

  function resetBall(w) {
    w.balls.length = 0;
    w.balls.push({
      x: w.paddle.x, y: w.paddle.y - BALL_R - 4, vx: 0, vy: 0, r: BALL_R,
      stuck: true, trail: [], cool: 0
    });
    w.energy = Math.max(w.energy, 55);
  }

  function launch(w) {
    for (var i = 0; i < w.balls.length; i++) {
      var b = w.balls[i];
      if (!b.stuck) continue;
      var ang = -Math.PI / 2 + (rnd() - 0.5) * (Math.PI / 3.2);
      var sp = baseSpeed(w.level);
      b.vx = Math.cos(ang) * sp; b.vy = Math.sin(ang) * sp;
      b.stuck = false; b.cool = 0.12;
    }
  }

  function spawnParticles(w, x, y, color, n, power) {
    for (var i = 0; i < n; i++) {
      var a = rnd() * Math.PI * 2, sp = 40 + rnd() * 200 * (power || 1);
      w.particles.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.35 + rnd() * 0.5, max: 0.85, color: color, size: 1.5 + rnd() * 2.6
      });
    }
    if (w.particles.length > 420) w.particles.splice(0, w.particles.length - 420);
  }

  function addPop(w, text, x, y, color) {
    if (!w.isMain) return;
    w.pops.push({ text: text, x: x, y: y, color: color });
    if (w.pops.length > 14) w.pops.shift();
  }

  function multiplier(w) {
    var m = 1 + Math.floor(w.combo / 5);
    if (w.effects.double > 0) m *= 2;
    return m;
  }

  function damageBrick(w, b, fromExplosion) {
    if (!b.alive) return false;
    if (b.kind === 'steel') {
      b.flash = 0.12;
      spawnParticles(w, b.x + b.w / 2, b.y + b.h / 2, '#9fb0d0', 4, 0.5);
      Sound.steel();
      return false;
    }
    b.hp -= 1;
    b.flash = 0.16;
    w.stats.dmg++;
    if (b.hp > 0) {
      Sound.armor();
      spawnParticles(w, b.x + b.w / 2, b.y + b.h / 2, b.color, 4, 0.6);
      return false;
    }
    // 破坏
    b.alive = false;
    w.remaining--;
    w.combo++; w.comboClock = COMBO_TIMEOUT;
    if (w.combo > w.bestCombo) w.bestCombo = w.combo;
    w.energy = Math.min(ENERGY_MAX, w.energy + ENERGY_PER_HIT);
    var gain = 10 * multiplier(w);
    w.score += gain;
    Sound.brick(w.combo); Sound.break_();
    spawnParticles(w, b.x + b.w / 2, b.y + b.h / 2, b.color, 10, 1);
    w.shake = Math.min(7, w.shake + (fromExplosion ? 0 : 1.1));
    if (w.combo > 1 && w.combo % 4 === 0) {
      addPop(w, '×' + multiplier(w), b.x + b.w / 2, b.y + b.h / 2, '#00dbff');
    }
    if (b.drop || rnd() < 0.1) {
      w.powerups.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, vy: 105, type: pickPower(), spin: 0 });
    }
    if (b.kind === 'bomb') explode(w, b);
    return true;
  }

  function explode(w, b) {
    w.shake = 9; w.flash = 0.22;
    spawnParticles(w, b.x + b.w / 2, b.y + b.h / 2, '#ffb900', 26, 1.7);
    Sound.break_();
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    for (var i = 0; i < w.bricks.length; i++) {
      var o = w.bricks[i];
      if (!o.alive || o === b) continue;
      var dx = (o.x + o.w / 2) - cx, dy = (o.y + o.h / 2) - cy;
      if (Math.abs(dx) <= CELL_W * 1.6 && Math.abs(dy) <= CELL_H * 1.6) {
        damageBrick(w, o, true);
      }
    }
  }

  function applyPower(w, type) {
    var p = POWER_TYPES[type];
    Sound.power();
    addPop(w, p.icon + ' ' + p.label, w.paddle.x, w.paddle.y - 40, p.color);
    if (type === 'multi') {
      var extra = [];
      for (var i = 0; i < w.balls.length && w.balls.length + extra.length < MAX_BALLS; i++) {
        var b = w.balls[i];
        var sp = Math.hypot(b.vx, b.vy) || baseSpeed(w.level);
        var base = Math.atan2(b.vy || -1, b.vx || 0);
        for (var k = -1; k <= 1; k += 2) {
          var a = base + k * 0.42;
          extra.push({
            x: b.x, y: b.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: BALL_R,
            stuck: false, trail: [], cool: 0.1
          });
        }
      }
      for (var j = 0; j < extra.length; j++) w.balls.push(extra[j]);
    } else if (type === 'life') {
      w.lives++;
    } else {
      w.effects[type] = POWER_TIME;
      if (type === 'wide') w.paddle.w = PADDLE_W * 1.55;
    }
  }

  // ---------------------------------------------------------------- 输入
  var input = { dir: 0, magnet: 0, slow: false };
  function resetInputs() {
    input.dir = 0; input.magnet = 0; input.slow = false;
    ['btn-attract', 'btn-repel', 'btn-slow'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('on');
    });
  }

  // ---------------------------------------------------------------- 物理
  function stepWorld(w, dt, inp) {
    if (w.over || w.cleared) return;
    w.time += dt;

    // 效果计时
    for (var k in w.effects) {
      if (w.effects[k] > 0) {
        w.effects[k] -= dt;
        if (w.effects[k] <= 0) {
          w.effects[k] = 0;
          if (k === 'wide') w.paddle.w = PADDLE_W;
        }
      }
    }

    // 时间缩放（慢动作耗能）
    var slowOn = inp.slow && w.energy > 1;
    var scale = slowOn ? SLOW_SCALE : 1;
    var dt2 = dt * scale;

    // 能量
    var drain = 0;
    if (inp.magnet !== 0 && w.energy > 1) drain += DRAIN_MAGNET;
    if (slowOn) drain += DRAIN_SLOW;
    w.energy = clamp(w.energy - drain * dt + (drain === 0 ? ENERGY_REGEN * dt : ENERGY_REGEN * 0.35 * dt), 0, ENERGY_MAX);

    // 连击超时
    if (w.combo > 0) {
      w.comboClock -= dt;
      if (w.comboClock <= 0) { w.combo = 0; }
    }

    // 挡板
    var pad = w.paddle;
    var maxSpd = 1650;
    if (inp.pointerX !== null) pad.targetX = inp.pointerX;
    else if (inp.dir !== 0) pad.targetX += inp.dir * 900 * dt;
    pad.targetX = clamp(pad.targetX, WALL + pad.w / 2, W - WALL - pad.w / 2);
    var prevX = pad.x;
    var dx = pad.targetX - pad.x;
    var mv = clamp(dx, -maxSpd * dt, maxSpd * dt);
    pad.x = clamp(pad.x + mv, WALL + pad.w / 2, W - WALL - pad.w / 2);
    pad.vx = (pad.x - prevX) / Math.max(dt, 1e-4);
    if (pad.glow > 0) pad.glow -= dt * 3;

    // 球
    var speedCap = SPEED_MAX * (slowOn ? 0.72 : 1);
    for (var i = w.balls.length - 1; i >= 0; i--) {
      var b = w.balls[i];
      if (b.cool > 0) b.cool -= dt;

      if (b.stuck) {
        b.x = pad.x; b.y = pad.y - b.r - 4;
        if (inp.launch) launch(w);
        continue;
      }

      // 磁场
      if (inp.magnet !== 0 && w.energy > 1) {
        var toward = inp.magnet > 0 ? 1 : -1;
        var ddx = pad.x - b.x;
        var dist = Math.max(60, Math.abs(ddx));
        var f = (inp.magnet > 0 ? MAGNET_ACC : REPEL_ACC) * toward;
        b.vx += (ddx / dist) * f * dt;
        b.vy += (inp.magnet > 0 ? 220 : -260) * dt;   // 吸：稍微往下拉；斥：往上推
      }

      // 限速（保持方向）
      var sp = Math.hypot(b.vx, b.vy) || 1;
      var target = Math.hypot(b.vx, b.vy);
      var ramp = 1 + 0.26 * (1 - w.remaining / Math.max(1, w.totalBreakable));
      var want = Math.min(speedCap, baseSpeed(w.level) * ramp);
      if (sp > want) { b.vx = b.vx / sp * want; b.vy = b.vy / sp * want; }
      if (Math.abs(b.vy) < want * 0.2) {
        b.vy = (b.vy >= 0 ? 1 : -1) * want * 0.2;
        var n2 = Math.hypot(b.vx, b.vy) || 1;
        b.vx = b.vx / n2 * want; b.vy = b.vy / n2 * want;
      }

      // 子步进移动 + 碰撞
      var move = Math.hypot(b.vx, b.vy) * dt2;
      var steps = Math.max(1, Math.ceil(move / 4));
      var sdt = dt2 / steps;
      for (var s = 0; s < steps; s++) {
        b.x += b.vx * sdt; b.y += b.vy * sdt;

        // 墙
        if (b.x - b.r < WALL) { b.x = WALL + b.r; b.vx = Math.abs(b.vx); w.stats.wall++; Sound.wall(); }
        else if (b.x + b.r > W - WALL) { b.x = W - WALL - b.r; b.vx = -Math.abs(b.vx); Sound.wall(); }
        if (b.y - b.r < WALL) { b.y = WALL + b.r; b.vy = Math.abs(b.vy); Sound.wall(); }

        // 砖块
        for (var bi = 0; bi < w.bricks.length; bi++) {
          var br = w.bricks[bi];
          if (!br.alive) continue;
          var cx = clamp(b.x, br.x, br.x + br.w), cy = clamp(b.y, br.y, br.y + br.h);
          var ddx2 = b.x - cx, ddy2 = b.y - cy;
          if (ddx2 * ddx2 + ddy2 * ddy2 > b.r * b.r) continue;
          // 最小穿透方向
          var oL = b.x + b.r - br.x, oR = br.x + br.w - (b.x - b.r);
          var oT = b.y + b.r - br.y, oB = br.y + br.h - (b.y - b.r);
          var mX = Math.min(oL, oR), mY = Math.min(oT, oB);
          if (mX < mY) {
            if (oL < oR) { b.x = br.x - b.r; b.vx = -Math.abs(b.vx); }
            else { b.x = br.x + br.w + b.r; b.vx = Math.abs(b.vx); }
          } else {
            if (oT < oB) { b.y = br.y - b.r; b.vy = -Math.abs(b.vy); }
            else { b.y = br.y + br.h + b.r; b.vy = Math.abs(b.vy); }
          }
          damageBrick(w, br, false);
          break;   // 一个子步只处理一块砖
        }

        // 挡板
        if (b.vy > 0 && b.y + b.r >= pad.y && b.y - b.r <= pad.y + pad.h &&
            b.x >= pad.x - pad.w / 2 - b.r && b.x <= pad.x + pad.w / 2 + b.r) {
          b.y = pad.y - b.r;
          var hitPos = clamp((b.x - pad.x) / (pad.w / 2), -1, 1);
          var ang = -Math.PI / 2 + hitPos * (Math.PI / 3);
          // 关键：不允许"垂直返回"。否则（尤其被完美跟球时）球会在同一列无限上下，
          // 只清掉一列砖就卡死。强制最小偏角，并加极小的随机抖动打破共振。
          var MIN_ANG = 0.21;                       // 约 12°
          if (Math.abs(Math.cos(ang)) < Math.sin(MIN_ANG)) {
            var sgn = hitPos > 0.02 ? 1 : (hitPos < -0.02 ? -1 : (b.vx !== 0 ? (b.vx > 0 ? 1 : -1) : (rnd() < 0.5 ? -1 : 1)));
            ang = -Math.PI / 2 + sgn * MIN_ANG;
          }
          ang += (rnd() - 0.5) * 0.04;
          var spd = Math.min(speedCap, Math.max(Math.hypot(b.vx, b.vy), baseSpeed(w.level) * 0.95));
          var spin = clamp(pad.vx * 0.12, -140, 140);
          b.vx = Math.cos(ang) * spd + spin;
          b.vy = Math.sin(ang) * spd;
          var nn = Math.hypot(b.vx, b.vy) || 1;
          if (nn > speedCap) { b.vx = b.vx / nn * speedCap; b.vy = b.vy / nn * speedCap; }
          pad.glow = 1;
          w.stats.paddle++;
          Sound.paddle();
          if (w.combo > 1) { w.combo = Math.floor(w.combo / 2); w.comboClock = COMBO_TIMEOUT; }
          if (w.effects.sticky > 0) {
            b.stuck = true; b.vx = 0; b.vy = 0;
          }
          break;
        }
      }

      // 轨迹
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 12) b.trail.shift();

      // 掉出底部
      if (b.y - b.r > H + 20) {
        w.balls.splice(i, 1);
      }
    }

    // 道具下落
    for (var pi = w.powerups.length - 1; pi >= 0; pi--) {
      var pu = w.powerups[pi];
      pu.y += pu.vy * dt2; pu.spin += dt2 * 3;
      if (pu.y > H - 30 && pu.y < H - 4 &&
          Math.abs(pu.x - pad.x) < pad.w / 2 + 16) {
        applyPower(w, pu.type);
        w.powerups.splice(pi, 1);
        continue;
      }
      if (pu.y > H + 20) w.powerups.splice(pi, 1);
    }

    // 激光
    if (w.effects.laser > 0) {
      w.laserTimer -= dt;
      if (w.laserTimer <= 0) {
        w.laserTimer = 0.55;
        w.lasers.push({ x: pad.x - pad.w / 2 + 6, y: pad.y - 6, vy: -640 });
        w.lasers.push({ x: pad.x + pad.w / 2 - 6, y: pad.y - 6, vy: -640 });
        Sound.steel();
      }
    }
    for (var li = w.lasers.length - 1; li >= 0; li--) {
      var L = w.lasers[li];
      L.y += L.vy * dt2;
      var hit = false;
      for (var bj = 0; bj < w.bricks.length; bj++) {
        var bb = w.bricks[bj];
        if (!bb.alive) continue;
        if (L.x >= bb.x && L.x <= bb.x + bb.w && L.y <= bb.y + bb.h && L.y >= bb.y - 6) {
          damageBrick(w, bb, false);
          hit = true; break;
        }
      }
      if (hit || L.y < WALL) w.lasers.splice(li, 1);
    }

    // 漂移砖
    for (var mi = 0; mi < w.bricks.length; mi++) {
      var mb = w.bricks[mi];
      if (mb.kind !== 'move' || !mb.alive) continue;
      mb.x += mb.dir * 38 * dt2;
      if (mb.x > mb.baseX + mb.range) { mb.x = mb.baseX + mb.range; mb.dir = -1; }
      if (mb.x < mb.baseX - mb.range) { mb.x = mb.baseX - mb.range; mb.dir = 1; }
    }

    // 粒子
    for (var qi = w.particles.length - 1; qi >= 0; qi--) {
      var pt = w.particles[qi];
      pt.life -= dt;
      if (pt.life <= 0) { w.particles.splice(qi, 1); continue; }
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vy += 320 * dt; pt.vx *= 0.99;
    }

    // 砖块闪光衰减
    for (var fi = 0; fi < w.bricks.length; fi++) {
      if (w.bricks[fi].flash > 0) w.bricks[fi].flash -= dt;
    }
    if (w.shake > 0) w.shake = Math.max(0, w.shake - dt * 22);
    if (w.flash > 0) w.flash = Math.max(0, w.flash - dt);

    // 生命 / 过关
    if (w.balls.length === 0) {
      w.lives--;
      w.stats.life++;
      w.combo = 0;
      Sound.lose();
      w.shake = 8;
      if (w.lives <= 0) { w.over = true; }
      else { resetBall(w); }
    }
    if (w.remaining <= 0 && !w.cleared) {
      w.cleared = true;
      Sound.clear();
    }
  }

  // ---------------------------------------------------------------- 渲染
  function renderWorld(w, ctx) {
    var sx = 0, sy = 0;
    if (w.shake > 0.2) {
      sx = (rnd() - 0.5) * w.shake; sy = (rnd() - 0.5) * w.shake;
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 背景
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a0d16'); g.addColorStop(1, '#07080d');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(sx, sy);

    // 网格
    ctx.strokeStyle = 'rgba(90,120,190,0.10)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = WALL; gx <= W - WALL; gx += CELL_W) { ctx.moveTo(gx, WALL); ctx.lineTo(gx, H); }
    for (var gy = GRID_TOP; gy < H; gy += CELL_H) { ctx.moveTo(WALL, gy); ctx.lineTo(W - WALL, gy); }
    ctx.stroke();

    // 边墙
    ctx.fillStyle = 'rgba(120,160,255,0.10)';
    ctx.fillRect(0, 0, WALL, H); ctx.fillRect(W - WALL, 0, WALL, H); ctx.fillRect(0, 0, W, WALL);

    // 砖块
    for (var i = 0; i < w.bricks.length; i++) {
      var b = w.bricks[i];
      if (!b.alive) continue;
      var alpha = 1;
      if (b.hp === 2) alpha = 0.78;
      else if (b.hp === 1 && b.kind === 'armor') alpha = 0.55;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = b.color;
      roundRect(ctx, b.x, b.y, b.w, b.h, 5);
      ctx.fill();
      // 内高光
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, b.x + 3, b.y + 3, b.w - 6, 3, 2); ctx.fill();
      ctx.globalAlpha = 1;
      if (b.flash > 0) {
        ctx.globalAlpha = clamp(b.flash * 5, 0, 1);
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, b.x, b.y, b.w, b.h, 5); ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (b.kind === 'steel') {
        ctx.strokeStyle = 'rgba(220,235,255,0.35)'; ctx.lineWidth = 1.5;
        roundRect(ctx, b.x + 3, b.y + 3, b.w - 6, b.h - 6, 3); ctx.stroke();
      }
      if (b.kind === 'bomb') {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y + b.h / 2, 3.2, 0, 6.284); ctx.fill();
      }
      if (b.drop) {
        ctx.fillStyle = 'rgba(20,25,40,0.8)';
        ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y + b.h / 2, 3.4, 0, 6.284); ctx.fill();
        ctx.fillStyle = '#ffe89a';
        ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y + b.h / 2, 1.8, 0, 6.284); ctx.fill();
      }
    }

    // 道具
    for (var pi = 0; pi < w.powerups.length; pi++) {
      var pu = w.powerups[pi], def = POWER_TYPES[pu.type];
      ctx.save();
      ctx.translate(pu.x, pu.y);
      ctx.rotate(Math.sin(pu.spin) * 0.25);
      ctx.fillStyle = def.color;
      ctx.shadowColor = def.color; ctx.shadowBlur = 14;
      roundRect(ctx, -16, -11, 32, 22, 7); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#0b0e16';
      ctx.font = 'bold 14px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(def.icon, 0, 1);
      ctx.restore();
    }

    // 激光
    ctx.fillStyle = '#ff6b83';
    for (var li = 0; li < w.lasers.length; li++) {
      var L = w.lasers[li];
      ctx.fillRect(L.x - 1.6, L.y - 16, 3.2, 16);
    }

    // 粒子
    for (var qi = 0; qi < w.particles.length; qi++) {
      var pt = w.particles[qi];
      ctx.globalAlpha = clamp(pt.life / pt.max, 0, 1);
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;

    // 球
    for (var bi = 0; bi < w.balls.length; bi++) {
      var ball = w.balls[bi];
      for (var t = 0; t < ball.trail.length; t++) {
        var tf = ball.trail[t] / ball.trail.length;
        ctx.globalAlpha = (t / ball.trail.length) * 0.4;
        ctx.fillStyle = '#8fd7ff';
        ctx.beginPath(); ctx.arc(ball.trail[t].x, ball.trail[t].y, ball.r * (0.35 + tf * 0.4), 0, 6.284); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowColor = '#bde9ff'; ctx.shadowBlur = 16;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.r, 0, 6.284); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // 挡板
    var pad = w.paddle;
    var pg = ctx.createLinearGradient(pad.x - pad.w / 2, 0, pad.x + pad.w / 2, 0);
    pg.addColorStop(0, '#ff4e6a'); pg.addColorStop(0.5, '#ffb900'); pg.addColorStop(1, '#00dbff');
    ctx.shadowColor = '#00dbff'; ctx.shadowBlur = 12 + pad.glow * 18;
    ctx.fillStyle = pg;
    roundRect(ctx, pad.x - pad.w / 2, pad.y, pad.w, pad.h, 7); ctx.fill();
    ctx.shadowBlur = 0;
    // 光标
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(pad.x - 1.5, pad.y - 3, 3, 4);

    // 磁场提示
    if (w.magnetHint) {
      ctx.strokeStyle = w.magnetHint > 0 ? 'rgba(0,219,255,0.45)' : 'rgba(255,78,106,0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pad.x, pad.y, 60 + Math.sin(w.time * 12) * 6, 0, 6.284); ctx.stroke();
    }

    // 闪白
    if (w.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (w.flash * 0.5) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------------------------------------------------------------- DOM
  var DPR = 1;
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('game'), ctx = canvas.getContext('2d');
  var stage = $('stage'), fx = $('fx'), selftestEl = $('selftest');
  var els = {
    score: $('hud-score'), best: $('hud-best'), level: $('hud-level'),
    lives: $('hud-lives'), combo: $('hud-combo'), energy: $('energy'),
    powerbar: $('powerbar'),
    ovStart: $('ov-start'), ovPause: $('ov-pause'), ovClear: $('ov-clear'), ovOver: $('ov-over'),
    clearLevel: $('clear-level'), clearScore: $('clear-score'), clearCombo: $('clear-combo'),
    overScore: $('over-score'), overCombo: $('over-combo'), overLevel: $('over-level'),
    overBest: $('over-best'), btnSound: $('btn-sound')
  };

  var best = 0, highestLevel = 1;
  try {
    best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;
  } catch (e) { best = 0; }

  function fitCanvas() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if (game) renderWorld(game, ctx);
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  var lastPowerSig = '';
  function hudPower(w) {
    var sig = '';
    for (var sk in w.effects) if (w.effects[sk] > 0) sig += sk + Math.ceil(w.effects[sk]) + '|';
    if (sig === lastPowerSig) return;
    lastPowerSig = sig;
    var out = [];
    for (var k in w.effects) {
      if (w.effects[k] > 0 && POWER_TYPES[k]) {
        out.push('<span class="chip"><i style="color:' + POWER_TYPES[k].color + '">' +
          POWER_TYPES[k].icon + '</i>' + POWER_TYPES[k].label +
          '<u>' + w.effects[k].toFixed(0) + 's</u></span>');
      }
    }
    els.powerbar.innerHTML = out.join('');
  }

  function syncHud(w) {
    els.score.textContent = w.score;
    els.best.textContent = best;
    els.level.textContent = w.endless && w.level > LEVELS.length ? '∞' + (w.level - LEVELS.length) : w.level;
    els.lives.textContent = w.lives > 0 ? new Array(Math.min(w.lives, 9) + 1).join('♥') : '—';
    els.combo.textContent = '×' + multiplier(w);
    els.energy.firstChild.style.width = (w.energy / ENERGY_MAX * 100).toFixed(1) + '%';
    els.energy.className = w.energy < 25 ? 'low' : '';
    hudPower(w);
  }

  function popText(text, lx, ly, color) {
    var el = document.createElement('div');
    el.className = 'pop'; el.textContent = text; el.style.color = color;
    var scale = stage.clientWidth / W;
    el.style.left = (lx * scale) + 'px';
    el.style.top = (ly * scale) + 'px';
    el.style.fontSize = Math.max(13, 20 * scale) + 'px';
    fx.appendChild(el);
    setTimeout(function () { el.remove(); }, 820);
  }

  function show(which) {
    [els.ovStart, els.ovPause, els.ovClear, els.ovOver].forEach(function (o) { o.classList.add('hidden'); });
    if (which === 'start') els.ovStart.classList.remove('hidden');
    if (which === 'pause') els.ovPause.classList.remove('hidden');
    var p2 = document.getElementById('btn-pause2');
    if (p2) { p2.firstChild.textContent = (which === 'pause') ? '继续' : '暂停'; }
    if (which === 'clear') els.ovClear.classList.remove('hidden');
    if (which === 'over') els.ovOver.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- 主状态机
  var game = null, menuWorld = null, mode = 'menu', needLaunch = false;

  function startGame(endless) {
    Sound.unlock();
    resetInputs();
    game = createWorld({ main: true, endless: !!endless, level: 1 });
    best = Math.max(best, 0);
    mode = 'play';
    show(null);
    syncHud(game);
  }

  function nextLevel() {
    resetInputs();
    var endless = game.endless;
    var lvl = game.level + 1;
    var carry = { score: game.score, lives: game.lives, bestCombo: game.bestCombo, endless: endless };
    game = createWorld({ main: true, endless: endless, level: lvl });
    game.score = carry.score; game.lives = carry.lives; game.bestCombo = carry.bestCombo;
    mode = 'play';
    show(null);
    syncHud(game);
  }

  function restart() { resetInputs(); startGame(game ? game.endless : false); }

  function gameOver() {
    if (game.score > best) {
      best = game.score;
      try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {}
    }
    els.overScore.textContent = game.score;
    els.overCombo.textContent = game.bestCombo;
    els.overLevel.textContent = game.level;
    els.overBest.textContent = '历史最高：' + best;
    mode = 'over';
    show('over');
  }

  // ---------------------------------------------------------------- 输入绑定
  function pointerToLogicalX(clientX) {
    var r = canvas.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width * W, 0, W);
  }

  var pointerActive = false;
  stage.addEventListener('mousemove', function (e) {
    if (mode !== 'play' || !game) return;
    if (e.buttons & 1) input.magnet = 1;
    else if (e.buttons & 2) input.magnet = -1;
    else input.magnet = 0;
    game.paddle.targetX = pointerToLogicalX(e.clientX);
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  stage.addEventListener('mousedown', function (e) {
    Sound.unlock();
    if (mode !== 'play' || !game) return;
    if (e.button === 0) { input.magnet = 1; needLaunch = true; }
    if (e.button === 2) input.magnet = -1;
  });
  window.addEventListener('mouseup', function () { input.magnet = 0; });

  stage.addEventListener('touchstart', function (e) {
    Sound.unlock();
    if (mode !== 'play' || !game) return;
    pointerActive = true;
    needLaunch = true;
    game.paddle.targetX = pointerToLogicalX(e.touches[0].clientX);
    e.preventDefault();
  }, { passive: false });
  stage.addEventListener('touchmove', function (e) {
    if (!pointerActive || mode !== 'play' || !game) return;
    game.paddle.targetX = pointerToLogicalX(e.touches[0].clientX);
    e.preventDefault();
  }, { passive: false });
  stage.addEventListener('touchend', function () { pointerActive = false; });

  window.addEventListener('keydown', function (e) {
    Sound.unlock();
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { input.dir = -1; e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { input.dir = 1; e.preventDefault(); }
    else if (k === 'z' || k === 'Z') { input.magnet = 1; }
    else if (k === 'x' || k === 'X') { input.magnet = -1; }
    else if (k === 'Shift') { input.slow = true; }
    else if (k === ' ') {
      e.preventDefault();
      if (mode === 'menu') startGame(false);
      else if (mode === 'play') needLaunch = true;
      else if (mode === 'pause') { mode = 'play'; show(null); }
    } else if (k === 'p' || k === 'P' || k === 'Escape') {
      if (mode === 'play') { mode = 'pause'; show('pause'); }
      else if (mode === 'pause') { mode = 'play'; show(null); }
    } else if (k === 'm' || k === 'M') {
      Sound.setMuted(!Sound.isMuted()); updateSoundBtn();
    } else if (k === 'r' || k === 'R') {
      if (mode !== 'menu') restart();
    }
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { if (input.dir === -1) input.dir = 0; }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { if (input.dir === 1) input.dir = 0; }
    else if (k === 'z' || k === 'Z' || k === 'x' || k === 'X') { input.magnet = 0; }
    else if (k === 'Shift') { input.slow = false; }
  });
  window.addEventListener('blur', function () {
    resetInputs();
    if (mode === 'play') { mode = 'pause'; show('pause'); }
  });

  function updateSoundBtn() {
    var m = Sound.isMuted();
    els.btnSound.textContent = m ? '🔇' : '🔊';
    els.btnSound.setAttribute('aria-pressed', m ? 'false' : 'true');
    var b2 = document.getElementById('btn-sound2');
    if (b2) { b2.firstChild.textContent = m ? '静音中' : '声音'; }
  }
  updateSoundBtn();

  $('btn-start').addEventListener('click', function () { startGame(false); });
  $('btn-endless').addEventListener('click', function () { startGame(true); });
  $('btn-resume').addEventListener('click', function () { mode = 'play'; show(null); });
  $('btn-restart').addEventListener('click', function () { restart(); });
  $('btn-next').addEventListener('click', function () { nextLevel(); });
  $('btn-again').addEventListener('click', function () { restart(); });
  $('btn-home').addEventListener('click', function () { mode = 'menu'; show('start'); });
  els.btnSound.addEventListener('click', function () { Sound.setMuted(!Sound.isMuted()); updateSoundBtn(); });
  // ---------------------------------------------------------------- 触屏实体按键
  // 手机上必须的：磁场要按住、慢动作要开关、发球/暂停/静音/重开都要能点
  [['btn-attract', 1], ['btn-repel', -1]].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    var t = 0;
    var press = function (e) {
      e.preventDefault(); e.stopPropagation();
      Sound.unlock();
      input.magnet = pair[1];
      el.classList.add('on');
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
      t = Date.now();
    };
    var release = function (e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      if (input.magnet === pair[1]) input.magnet = 0;
      el.classList.remove('on');
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });

  var btnFire = document.getElementById('btn-fire');
  if (btnFire) btnFire.addEventListener('click', function (e) {
    e.preventDefault(); Sound.unlock();
    if (mode === 'menu') startGame(false);
    else if (mode === 'pause') { mode = 'play'; show(null); }
    else needLaunch = true;
  });

  var btnSlow = document.getElementById('btn-slow');
  if (btnSlow) btnSlow.addEventListener('click', function (e) {
    e.preventDefault(); Sound.unlock();
    input.slow = !input.slow;
    btnSlow.classList.toggle('on', input.slow);
  });

  var btnPause2 = document.getElementById('btn-pause2');
  if (btnPause2) btnPause2.addEventListener('click', function (e) {
    e.preventDefault();
    if (mode === 'play') { mode = 'pause'; show('pause'); }
    else if (mode === 'pause') { mode = 'play'; show(null); }
  });

  var btnSound2 = document.getElementById('btn-sound2');
  if (btnSound2) btnSound2.addEventListener('click', function (e) {
    e.preventDefault();
    Sound.setMuted(!Sound.isMuted()); updateSoundBtn();
  });

  var btnRestart2 = document.getElementById('btn-restart2');
  if (btnRestart2) btnRestart2.addEventListener('click', function (e) {
    e.preventDefault();
    if (mode !== 'menu') restart(); else startGame(false);
  });

  $('btn-pause').addEventListener('click', function () {
    if (mode === 'play') { mode = 'pause'; show('pause'); }
    else if (mode === 'pause') { mode = 'play'; show(null); }
  });

  // ---------------------------------------------------------------- 主循环
  var acc = 0, last = 0, running = true;
  var params = new URLSearchParams(location.search);
  var shotLevel = params.get('shot');
  var shotTime = parseFloat(params.get('t') || '5');
  var selftest = params.has('selftest');
  var speedup = parseFloat(params.get('speed') || '1');   // 自测/截图专用倍速

  function frame(ts) {
    if (!last) last = ts;
    var dt = Math.min((ts - last) / 1000, MAX_FRAME);
    last = ts;

    if (mode === 'play' && game) {
      var localInput = {
        dir: input.dir,
        pointerX: null,
        magnet: input.magnet,
        slow: input.slow,
        launch: needLaunch
      };
      game.magnetHint = (input.magnet !== 0 && game.energy > 1) ? input.magnet : 0;
      needLaunch = false;
      var total = dt * speedup;
      acc += total;
      var guard = 0;
      while (acc >= FIXED && guard < 600) {
        stepWorld(game, FIXED, localInput);
        acc -= FIXED; guard++;
        if (game.over || game.cleared) break;
      }
      if (game.over) gameOver();
      else if (game.cleared) {
        els.clearLevel.textContent = game.level;
        els.clearScore.textContent = game.score;
        els.clearCombo.textContent = game.bestCombo;
        mode = 'clear'; show('clear');
      }
      renderWorld(game, ctx);
      syncHud(game);
      // DOM 浮字
      if (game.pops.length) {
        for (var i = 0; i < game.pops.length; i++) {
          var p = game.pops[i];
          popText(p.text, p.x, p.y, p.color);
        }
        game.pops.length = 0;
      }
    } else if (game) {
      renderWorld(game, ctx);
    } else {
      if (!menuWorld) menuWorld = createWorld({ main: false });
      renderWorld(menuWorld, ctx);
    }
    if (running) requestAnimationFrame(frame);
  }

  // 截图模式：用机器人自动打一段时间，冻住画面供截图
  if (shotLevel) {
    game = createWorld({ main: true, level: parseInt(shotLevel, 10) || 1 });
    mode = 'play';
    show(null);
    game.paddle.targetX = W / 2;
    runBot(game, shotTime);
    renderWorld(game, ctx);
    syncHud(game);
    running = false;
    requestAnimationFrame(function () { renderWorld(game, ctx); });
  } else if (!selftest) {
    mode = 'menu';
    show('start');
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- 机器人 + 自测
  function predictLanding(b) {
    // 球到挡板高度时的 x（含左右墙反射）
    var t = (w0PaddleY() - b.y) / (b.vy || 1);
    if (t < 0) t = 0;
    var x = b.x + b.vx * t;
    var span = W - WALL * 2;
    var rel = ((x - WALL) % (span * 2) + span * 2) % (span * 2);
    if (rel > span) rel = span * 2 - rel;
    return WALL + rel;
  }
  function w0PaddleY() { return PADDLE_Y; }

  function botTarget(w) {
    var ball = null, maxY = -1e9;
    for (var i = 0; i < w.balls.length; i++) {
      if (w.balls[i].y > maxY) { maxY = w.balls[i].y; ball = w.balls[i]; }
    }
    if (!ball) return w.paddle.x;
    if (ball.stuck) return ball.x;
    var landing = predictLanding(ball);
    // 只在球开始下落时瞄准；球还在上方飞时先跟住
    if (ball.vy <= 0 || ball.y < H * 0.35) return landing;

    // 找目标砖：优先离挡板近、且横向可及的
    var best = null, bestScore = 1e9;
    for (var j = 0; j < w.bricks.length; j++) {
      var br = w.bricks[j];
      if (!br.alive || br.kind === 'steel') continue;
      var cx = br.x + br.w / 2, cy = br.y + br.h / 2;
      var sc = (w.paddle.y - cy) + Math.abs(cx - landing) * 0.55 - (br.kind === 'armor' ? 0 : 40) - (br.kind === 'bomb' ? 60 : 0);
      if (sc < bestScore) { bestScore = sc; best = br; }
    }
    if (!best) return landing;
    var tx = best.x + best.w / 2, ty = best.y + best.h / 2;

    // 想要的角度 -> 想要的击球点 -> 反推挡板应该在哪
    var px = landing;
    for (var it = 0; it < 3; it++) {
      var ang = Math.atan2(ty - w.paddle.y, tx - px);
      if (ang >= 0) ang = -0.3;
      var hitPos = clamp((ang + Math.PI / 2) / (Math.PI / 3), -1, 1);
      px = landing - hitPos * (w.paddle.w / 2);
    }
    return clamp(px, WALL + w.paddle.w / 2, W - WALL - w.paddle.w / 2);
  }

  function runBot(w, seconds, dt) {
    dt = dt || FIXED;
    Sound.setSilent(true);
    var steps = Math.floor(seconds / dt);
    for (var i = 0; i < steps; i++) {
      var stuck = w.balls.length && w.balls[0].stuck;
      var inp = { dir: 0, pointerX: botTarget(w), magnet: 0, slow: false, launch: stuck };
      stepWorld(w, dt, inp);
      if (w.over) break;
    }
    return w;
  }

  function runSelfTest() {
    var results = { pass: true, checks: [], levels: [] };
    function check(name, ok, extra) {
      results.checks.push({ name: name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
      if (!ok) results.pass = false;
    }

    // 固定随机种子 + 关音频，保证可复现、跑得快
    rnd = mulberry32(20261009);
    Sound.setSilent(true);

    // 1) 关卡结构
    for (var li = 0; li < LEVELS.length; li++) {
      var bricks = parseLevel(LEVELS[li].rows);
      var breakable = 0, bad = 0, overlap = 0;
      for (var i = 0; i < bricks.length; i++) {
        var b = bricks[i];
        if (b.kind !== 'steel') breakable++;
        if (b.x < WALL - 0.5 || b.x + b.w > W - WALL + 0.5 || b.y < WALL) bad++;
        for (var j = i + 1; j < bricks.length; j++) {
          var o = bricks[j];
          if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) overlap++;
        }
      }
      check('L' + (li + 1) + ' ' + LEVELS[li].name + ' 有可破坏砖', breakable > 0, breakable);
      check('L' + (li + 1) + ' 砖块都在场地内', bad === 0, bad + ' 块越界');
      check('L' + (li + 1) + ' 砖块不重叠', overlap === 0, overlap + ' 处重叠');
    }

    // 2) 机器人打通每一关（同时检测：球不越界 / 无 NaN / 关卡可在时限内清空）
    var BUDGET = 240;
    for (var lv = 1; lv <= LEVELS.length; lv++) {
      var w = createWorld({ level: lv });
      var t = 0, escaped = 0, nan = 0;
      while (!w.cleared && !w.over && t < BUDGET) {
        var stuck = w.balls.length && w.balls[0].stuck;
        stepWorld(w, FIXED, { dir: 0, pointerX: botTarget(w), magnet: 0, slow: false, launch: stuck });
        if (lv === 1) {
          if (!w.__band) w.__band = [0, 0, 0, 0, 0, 0];
          w.__band[Math.min(5, Math.max(0, Math.floor((w.balls[0] ? w.balls[0].y : 0) / 100)))]++;
          if (!w.__trace) w.__trace = [];
          if (w.__n === undefined) w.__n = 0;
          if (w.__n++ % 240 === 0 && w.__trace.length < 40 && w.balls[0]) {
            var tb = w.balls[0];
            w.__trace.push([+t.toFixed(2), Math.round(tb.x), Math.round(tb.y),
                            Math.round(tb.vx), Math.round(tb.vy), tb.stuck ? 1 : 0,
                            Math.round(w.paddle.x), w.remaining]);
          }
        }
        for (var bi = 0; bi < w.balls.length; bi++) {
          var bb = w.balls[bi];
          if (!isFinite(bb.x) || !isFinite(bb.y) || !isFinite(bb.vx)) nan++;
          if (bb.x < WALL - 26 || bb.x > W - WALL + 26 || bb.y < -40 || bb.y > H + 60) escaped++;
        }
        t += FIXED;
      }
      var rec = {
        stats: w.stats, band: w.__band || null,
        level: lv, name: LEVELS[lv - 1].name, cleared: !!w.cleared,
        seconds: Math.round(t * 10) / 10, score: w.score, bestCombo: w.bestCombo,
        lives: w.lives, escaped: escaped, nan: nan
      };
      if (lv === 1) { results.trace = w.__trace || []; results.bandHeaders = ['0-100','100-200','200-300','300-400','400-500','500-600']; }
      results.levels.push(rec);
      check('L' + lv + ' 机器人能清关（≤' + BUDGET + 's）', w.cleared, rec.seconds + 's');
      check('L' + lv + ' 球没飞出场地', escaped === 0, escaped);
      check('L' + lv + ' 无 NaN', nan === 0, nan);
    }

    // 3) 道具效果
    var pw = createWorld({ level: 1 });
    var types = POWER_KEYS.slice();
    for (var pi = 0; pi < types.length; pi++) {
      var before = pw.balls.length, lives0 = pw.lives;
      try {
        applyPower(pw, types[pi]);
        for (var s2 = 0; s2 < 240; s2++) {
          stepWorld(pw, FIXED, { dir: 0, pointerX: botTarget(pw), magnet: 0, slow: false, launch: true });
        }
        var okEffect = true;
        if (types[pi] === 'multi') okEffect = pw.balls.length > before;
        if (types[pi] === 'life') okEffect = pw.lives > lives0;
        if (types[pi] === 'wide') okEffect = pw.paddle.w > PADDLE_W;
        check('道具 ' + types[pi] + ' 生效', okEffect);
      } catch (err) {
        check('道具 ' + types[pi] + ' 生效', false, err.message);
      }
    }

    // 4) 磁场与慢动作确实消耗能量
    var mw = createWorld({ level: 1 });
    launch(mw);
    var e0 = mw.energy;
    for (var s3 = 0; s3 < 120; s3++) {
      stepWorld(mw, FIXED, { dir: 0, pointerX: botTarget(mw), magnet: 1, slow: true, launch: false });
    }
    check('磁场/慢动作耗能', mw.energy < e0, e0.toFixed(1) + ' → ' + mw.energy.toFixed(1));

    // 5) 连击与倍率（确定性检查，不依赖机器人运气）
    var cw = createWorld({ level: 1 });
    var alive = cw.bricks.filter(function (b) { return b.alive && b.kind !== 'steel'; });
    for (var ci = 0; ci < 12 && ci < alive.length; ci++) damageBrick(cw, alive[ci], false);
    check('连击能累积到 12', cw.combo === 12, 'combo=' + cw.combo);
    check('倍率 = 1 + floor(combo/5)', multiplier(cw) === 3, '×' + multiplier(cw));

    // 碰挡板 -> 连击减半
    var hw = createWorld({ level: 1 });
    hw.combo = 12; hw.comboClock = COMBO_TIMEOUT;
    var hb = hw.balls[0];
    hb.stuck = false; hb.x = hw.paddle.x; hb.y = hw.paddle.y - 12; hb.vx = 0; hb.vy = 260;
    for (var hs = 0; hs < 40 && hw.combo === 12; hs++) {
      stepWorld(hw, FIXED, { dir: 0, pointerX: hw.paddle.x, magnet: 0, slow: false, launch: false });
    }
    check('碰挡板后连击减半', hw.combo === 6, 'combo=' + hw.combo);

    // 长时间不碰砖 -> 连击清零
    var tw = createWorld({ level: 1 });
    damageBrick(tw, tw.bricks.filter(function (b) { return b.alive && b.kind !== 'steel'; })[0], false);
    var before0 = tw.combo;
    for (var ts = 0; ts < 120 * 5; ts++) {
      stepWorld(tw, FIXED, { dir: 0, pointerX: botTarget(tw), magnet: 0, slow: false, launch: true });
    }
    check('连击超时会清零', before0 === 1 && tw.combo <= 3, 'start=1 end=' + tw.combo);

    // 实战里连击能上两位数（取所有关卡的最好成绩）
    var bestAny = 0;
    for (var bi2 = 0; bi2 < results.levels.length; bi2++) {
      if (results.levels[bi2].bestCombo > bestAny) bestAny = results.levels[bi2].bestCombo;
    }
    check('实战最佳连击 ≥ 8', bestAny >= 8, 'best=' + bestAny);

    // 6) 触屏实体按键（手机能不能玩，全靠这一组测试）
    var ids = ['btn-fire', 'btn-attract', 'btn-repel', 'btn-slow', 'btn-pause2', 'btn-sound2', 'btn-restart2'];
    var missing = ids.filter(function (id) { return !document.getElementById(id); });
    check('七个实体按键都在页面上', missing.length === 0, missing.join(','));

    function fire(el, type) {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 99 }));
    }
    var at = document.getElementById('btn-attract');
    var rp = document.getElementById('btn-repel');
    var sl = document.getElementById('btn-slow');
    if (at && rp && sl) {
      resetInputs();
      fire(at, 'pointerdown');
      check('按住「吸」→ 磁场=吸引', input.magnet === 1, 'magnet=' + input.magnet);
      fire(at, 'pointerup');
      check('松开「吸」→ 磁场归零', input.magnet === 0, 'magnet=' + input.magnet);
      fire(rp, 'pointerdown');
      check('按住「斥」→ 磁场=排斥', input.magnet === -1, 'magnet=' + input.magnet);
      fire(rp, 'pointerup');
      check('松开「斥」→ 磁场归零', input.magnet === 0, 'magnet=' + input.magnet);
      var s0 = input.slow;
      sl.click();
      check('「慢动作」可点开', input.slow === !s0, 'slow=' + input.slow);
      sl.click();
      check('「慢动作」可点关', input.slow === s0, 'slow=' + input.slow);
      var fireBtn = document.getElementById('btn-fire');
      fireBtn.click();
      check('「发球」能从菜单开局', mode === 'play' && !!game, 'mode=' + mode);
      resetInputs();
    }

    var json = JSON.stringify(results, null, 1);
    if (selftestEl) { selftestEl.hidden = false; selftestEl.textContent = json; }
    document.title = (results.pass ? 'SELFTEST PASS' : 'SELFTEST FAIL') + ' ' +
      results.checks.filter(function (c) { return !c.ok; }).length + ' failed';
    return results;
  }

  if (selftest) {
    try { window.__selftest = runSelfTest(); }
    catch (err) {
      if (selftestEl) { selftestEl.hidden = false; selftestEl.textContent = 'THREW: ' + err.message + '\n' + err.stack; }
      document.title = 'SELFTEST THREW';
    }
  }

  // 对外暴露一点东西，方便调试
  window.BreakoutNEON = {
    input: input, resetInputs: resetInputs, getMode: function () { return mode; },
    createWorld: createWorld, stepWorld: stepWorld, renderWorld: renderWorld,
    runBot: runBot, LEVELS: LEVELS, parseLevel: parseLevel
  };
})();
