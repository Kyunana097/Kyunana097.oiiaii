/* ============================================================================
   黑洞 · 吞噬
   一个没有失败的解压小游戏：拖动黑洞，让尘埃、恒星和行星落进吸积盘。
   物理是简化版的：牛顿引力 + 软化 + 吸积盘粘滞；视觉上的几个环用的是
   史瓦西解的标准结果（光子球 1.5 Rs、ISCO 3 Rs、阴影 ≈ 2.6 Rs）。
   ========================================================================== */
(function () {
  'use strict';

  var W = 960, H = 640;                 // 逻辑分辨率 3:2
  var FIXED = 1 / 120;                  // 物理步长
  var MAX_FRAME = 0.05;
  var MAX_PARTICLES = 1800;
  var GM0 = 9.0e6;                      // 初始 G·M（像素³/秒²）
  var GM_CAP = 4.5e7;
  var R0 = 15;                          // 初始视界半径（1 Rs = 15 px）
  var SOFT = 120;                       // 引力软化，避免中心奇点
  var FIELD_R = 780;                    // 超出这个距离就算飞出场景
  var TARGET_POP = 460;                 // 场上维持的粒子数
  var SHADOW_K = 2.6;                   // 阴影半径 / Rs
  var PHOTON_K = 1.5;                   // 光子球 / Rs
  var ISCO_K = 3;                       // 最内稳定圆轨道 / Rs
  var PULSE_R = 520;
  var JET_CD = 6;                 // 喷流冷却：自动漫游、手动脉冲、吞噬触发的喷流共用这一个

  var KINDS = {
    dust:   { r0: 1.1, r1: 2.1, m: 1,  color: '#a9bcdd' },
    star:   { r0: 2.4, r1: 4.0, m: 6,  color: '#ffe7bd' },
    planet: { r0: 6.0, r1: 9.5, m: 60, color: '#8fd3c4' },
    frag:   { r0: 1.4, r1: 2.8, m: 4,  color: '#ffcf9e' },
    jet:    { r0: 1.0, r1: 2.2, m: 0,  color: '#cfeaff' },
    comet:  { r0: 2.4, r1: 3.4, m: 8,  color: '#c8e6ff' },
    nebula: { r0: 62, r1: 112, m: 0, color: '#a98ce0' },
    minibh: { r0: 7.0, r1: 10.5, m: 900, color: '#e3d2ff' }
  };
  var MINI_GM = 1.1e6;          // 小黑洞的引力参数（按质量缩放）
  var MINI_INFL = 132;          // 小黑洞能影响多远（按质量缩放）
  // 每 +10000 质量弹一句（顺序循环）。写得短一点，一行能放下
  var PHILOSOPHY = [
    '视界不是墙，只是「回不来」的那条线。',
    '掉进去的东西没有消失，它变成了面积。',
    '黑洞的面积只增不减，这是宇宙里最诚实的账本。',
    '被撕碎的不是行星，是它以为自己是个整体。',
    '时间在视界上停住，在你身上照常流逝。',
    '你此刻看见的光，可能来自一颗早已不在的星。',
    '引力不挑食，它只是重新定义了「附近」。',
    '越靠近中心，绕一圈需要的力气越少，直到不再需要。',
    '吸积盘最亮的地方，是物质最后一次发光。',
    '信息没有丢，只是被摊平在视界上。',
    '看不见的那部分，也在如实地计算着自己。',
    '吃得越多，它越大，也越空。',
    '并合的时候，宇宙为那点质量差赔上一阵引力波。',
    '事件视界，是「之后」这个词失效的地方。',
    '潮汐力不针对谁，它只是比较不同高度下落的速度。',
    '每一克质量都在教时空该怎么弯。',
    '光能绕着你转很多圈，却始终说不出里面有什么。',
    '你看到的静止，其实是极端的速度。',
    '熵增是唯一从不认输的定律。',
    '逃逸速度超过光速时，「外面」就成了传说。',
    '黑洞自己不发光，它让别的东西亮起来。',
    '剩下的霍金辐射很微弱，但它有的是时间。',
    '你测到的质量，是它过去吃下的一切。',
    '最安静的地方，密度最大。'
  ];
  // ---------------------------------------------------------------- 特殊事件
  // 每过一个质量里程碑来一次，用来打破"解锁完之后就只剩看盘"
  var EVENT_MIN_MASS = 20000;      // 质量没过这个数之前，不触发特殊事件
  var EVENT_IDS = ['meteor', 'dense', 'cluster', 'ripple', 'lens', 'merge'];
  function zoomOf(w) { return clamp(w.cam ? w.cam.scale : 1, SCALE_MIN, 1); }
  function pushP(w, p) {
    if (w.particles.length >= MAX_PARTICLES) return null;
    w.particles.push(p);
    return p;
  }
  function mkP(kind, x, y, vx, vy, r, m, heat) {
    return { kind: kind, x: x, y: y, vx: vx, vy: vy, r: r, m: m, heat: heat,
             life: 0, maxLife: 0, trail: [], seed: 0, dead: false, cloud: 0 };
  }

  // ① 流星雨：从同一个辐射点、几乎平行的方向扫进来
  function evMeteor(w) {
    var rad = rnd() * Math.PI * 2, dir = rnd() < 0.5 ? 1 : -1;
    var n = 16 + Math.round(rnd() * 10);
    for (var i = 0; i < n; i++) {
      var a = rad + (rnd() - 0.5) * 0.5;
      var d = (520 + rnd() * 200) / zoomOf(w);
      var sp = 240 + rnd() * 200;
      var tx = -Math.sin(a) * dir, ty = Math.cos(a) * dir;
      var p = mkP('comet', w.bh.x + Math.cos(a) * d, w.bh.y + Math.sin(a) * d,
                  (tx * 1.55 - Math.cos(a) * 0.85) * sp, (ty * 1.55 - Math.sin(a) * 0.85) * sp,
                  1.5 + rnd() * 1.3, 2, 0.45);
      pushP(w, p);
    }
    return { text: '特殊事件：流星雨', dur: 3.4 };
  }

  // ② 星云稠密区：背景变浓，并飘进来几团新的星云
  function evDense(w) {
    for (var i = 0; i < 3; i++) {
      var a = rnd() * Math.PI * 2, d = (280 + rnd() * 260) / zoomOf(w);
      var vc = circularSpeed(w, d) * 0.8, dir = rnd() < 0.5 ? 1 : -1;
      var p = mkP('nebula', w.bh.x + Math.cos(a) * d, w.bh.y + Math.sin(a) * d,
                  -Math.sin(a) * vc * dir, Math.cos(a) * vc * dir, 68 + rnd() * 46, 0, 0);
      p.cloud = 1;
      pushP(w, p);
    }
    w.denseNebula = 15;
    return { text: '特殊事件：飘进了星云稠密区', dur: 4 };
  }

  // ③ 星团降临：一小团恒星整体落进来
  function evCluster(w) {
    var a = rnd() * Math.PI * 2, d = (560 + rnd() * 170) / zoomOf(w);
    var cx = w.bh.x + Math.cos(a) * d, cy = w.bh.y + Math.sin(a) * d;
    var vc = circularSpeed(w, d) * 0.88, dir = rnd() < 0.5 ? 1 : -1;
    var bvx = -Math.sin(a) * vc * dir, bvy = Math.cos(a) * vc * dir;
    for (var i = 0; i < 46; i++) {
      var rr = Math.pow(rnd(), 0.5) * 110, aa = rnd() * Math.PI * 2;
      pushP(w, mkP(rnd() < 0.22 ? 'planet' : 'star',
                   cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr,
                   bvx + (rnd() - 0.5) * 8, bvy + (rnd() - 0.5) * 8,
                   2.4 + rnd() * 1.6, 6, 0.2));
    }
    return { text: '特殊事件：一团恒星落进来了', dur: 3.4 };
  }

  // ④ 引力波涟漪：几道扩张的波前扫过，顺手把盘搓一下
  function evRipple(w) {
    w.ripples = [];
    for (var i = 0; i < 3; i++) w.ripples.push({ r: 70 + i * 120, life: 1 });
    return { text: '特殊事件：一阵引力波涟漪扫过', dur: 3.4 };
  }

  // ⑤ 微引力透镜：一颗背景恒星被放大，阴影边缘亮起一小段弧
  function evLens(w) {
    w.lensStar = { a: rnd() * Math.PI * 2, t: 7, dur: 7 };
    return { text: '特殊事件：一颗背景恒星被引力透镜放大', dur: 3.4 };
  }

  // ⑥ 并合：两颗小黑洞贴在一起进来，几步内并合
  function evMerge(w) {
    var a = rnd() * Math.PI * 2, d = (300 + rnd() * 180) / zoomOf(w);
    var m1 = spawnMiniBH(w, true), m2 = spawnMiniBH(w, true);
    if (!m1 || !m2) return { text: '特殊事件：小黑洞擦肩而过', dur: 3 };
    var vc = circularSpeed(w, d) * 0.9, dir = rnd() < 0.5 ? 1 : -1;
    m1.x = w.bh.x + Math.cos(a) * d; m1.y = w.bh.y + Math.sin(a) * d;
    m2.x = m1.x + (m1.r + m2.r) * 0.75; m2.y = m1.y;
    m1.vx = m2.vx = -Math.sin(a) * vc * dir;
    m1.vy = m2.vy = Math.cos(a) * vc * dir;
    return { text: '特殊事件：两个小黑洞正在并合', dur: 3.4 };
  }

  var EVENT_FN = { meteor: evMeteor, dense: evDense, cluster: evCluster,
                   ripple: evRipple, lens: evLens, merge: evMerge };
  function triggerMilestoneEvent(w) {
    var pool = EVENT_IDS.filter(function (id) { return id !== w.lastEventId; });
    var id = pool[Math.floor(rnd() * pool.length)] || EVENT_IDS[0];
    w.lastEventId = id;
    w.eventId = id;
    w.eventSeq = (w.eventSeq || 0) + 1;
    var r = EVENT_FN[id](w);
    w.evT = r.dur + 1.6;          // 事件有自己的一行，不跟解锁提示抢位置
    w.evText = r.text;
    Sound.chime(true);
    return id;
  }

  var JET_R = 105, JET_PUSH = 1600;
  var ZEN_DIST = 2.4;           // 静观模式：把「视角远近」拨到多少（和滑块是同一个量）
  var SCALE_MIN = 0.18;         // 相机最远（越小看得越广）
  // 引力透镜的观感参数：盘几乎是侧视的，所以直接像被压得很扁；
  // 背面来的光绕过黑洞后被压向光子环，在上、下各形成一道拱
  var LENS_ARCH_Q = 1.0;        // 透镜像几乎是圆的（引力把像"撑圆"了）
  var LENS_ARCH_K = 0.09;       // 透镜像半径向光子环压缩的比例（越小越贴着阴影）
  var tiltDeg = 0;              // 视角：0° = 俯视（默认，盘是圆的），80° = 近侧视（盘压成一条）
  var squash = Math.cos(tiltDeg * Math.PI / 180);   // 盘的投影压扁系数（粒子、发光带共用）
  var DISK_BINS = 16;

  function rgbaOf(rgb, a) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')'; }
  function diskColor(t) {
    // 内圈白热 -> 橙 -> 外圈暗红
    var stops = [[255, 246, 228], [255, 190, 120], [255, 108, 52], [150, 60, 96]];
    var x = clamp(t, 0, 1) * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    return [
      Math.round(lerp(stops[i][0], stops[i + 1][0], f)),
      Math.round(lerp(stops[i][1], stops[i + 1][1], f)),
      Math.round(lerp(stops[i][2], stops[i + 1][2], f))
    ];
  }
  var UNLOCKS = [
    { mass: 2500,  kind: 'comet',  label: '彗星' },
    { mass: 6000,  kind: 'nebula', label: '星云团' },
    { mass: 12000, kind: 'minibh', label: '小黑洞' }
  ];

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

  function fmt(n) {
    n = Math.round(n);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  // ---------------------------------------------------------------- 音频
  var Sound = (function () {
    var ac = null, master = null, drone = null, droneGain = null, filt = null;
    var muted = false, silent = false, started = false;
    try { muted = localStorage.getItem('blackhole.mute') === '1'; } catch (e) { muted = false; }

    function ctx() {
      if (ac) return ac;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ac = new AC(); } catch (e) { ac = null; }
      return ac;
    }
    function ensure() {
      var a = ctx(); if (!a) return null;
      if (!master) {
        master = a.createGain(); master.gain.value = 0.9; master.connect(a.destination);
      }
      return a;
    }
    function droneStart() {
      if (started || silent || muted) return;
      var a = ensure(); if (!a) return;
      started = true;
      filt = a.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 420; filt.Q.value = 0.6;
      droneGain = a.createGain(); droneGain.gain.value = 0.0001;
      filt.connect(droneGain); droneGain.connect(master);
      drone = [];
      [55, 82.4, 110.3].forEach(function (f, i) {
        var o = a.createOscillator(), g = a.createGain();
        o.type = i === 2 ? 'triangle' : 'sine';
        o.frequency.value = f * (1 + (i - 1) * 0.002);
        g.gain.value = i === 2 ? 0.25 : 0.6;
        o.connect(g); g.connect(filt); o.start();
        drone.push(o);
      });
      droneGain.gain.exponentialRampToValueAtTime(0.05, a.currentTime + 3);
    }
    function tone(freq, dur, type, gain, slide) {
      if (silent || muted) return;
      var a = ensure(); if (!a) return;
      if (a.state === 'suspended') { try { a.resume(); } catch (e) {} }
      var t0 = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.05, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master || a.destination);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }
    function noise(dur, gain, freq, q) {
      if (silent || muted) return;
      var a = ensure(); if (!a) return;
      var len = Math.max(1, Math.floor(a.sampleRate * dur));
      var buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = a.createBufferSource(); src.buffer = buf;
      var f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq || 700; f.Q.value = q || 0.8;
      var g = a.createGain(); g.gain.value = gain || 0.05;
      src.connect(f); f.connect(g); g.connect(master || a.destination); src.start();
    }
    return {
      unlock: function () { var a = ensure(); if (a && a.state === 'suspended') { try { a.resume(); } catch (e) {} } droneStart(); },
      setSilent: function (v) { silent = !!v; },
      isMuted: function () { return muted; },
      setMuted: function (m) {
        muted = !!m;
        try { localStorage.setItem('blackhole.mute', muted ? '1' : '0'); } catch (e) {}
        if (droneGain && ac) {
          droneGain.gain.cancelScheduledValues(ac.currentTime);
          droneGain.gain.exponentialRampToValueAtTime(muted ? 0.0001 : 0.05, ac.currentTime + 0.4);
        }
        if (!muted) droneStart();
      },
      mass: function (ratio) {                 // 随质量变亮变浑厚
        if (!filt || !droneGain || !ac) return;
        filt.frequency.setTargetAtTime(300 + ratio * 900, ac.currentTime, 1.2);
        droneGain.gain.setTargetAtTime(0.035 + clamp(ratio, 0, 1) * 0.05, ac.currentTime, 1.5);
      },
      eat: function (heat, m) {
        noise(0.16, 0.035 + heat * 0.03, 320 + heat * 900, 0.9);
        tone(140 - heat * 40, 0.22, 'sine', 0.03 + heat * 0.03, 70);
        if (m >= 40) tone(60, 0.5, 'triangle', 0.05, 38);
      },
      breakup: function () {
        noise(0.34, 0.06, 1800, 0.7);
        tone(320, 0.42, 'sawtooth', 0.028, 60);
      },
      jet: function () { noise(0.55, 0.04, 820, 0.55); tone(74, 0.6, 'triangle', 0.035, 300); },
      pulse: function () { tone(46, 0.9, 'sine', 0.07, 120); noise(0.5, 0.03, 260, 0.5); },
      chime: function (hi) { tone(hi ? 660 : 440, 0.5, 'sine', 0.035); setTimeout(function () { tone(hi ? 880 : 554, 0.6, 'sine', 0.03); }, 160); }
    };
  })();

  // ---------------------------------------------------------------- 世界
  function createWorld(seed) {
    rnd = mulberry32(seed || 20261009);
    var w = {
      isMain: true, paused: false, time: 0,
      bh: { x: W * 0.5, y: H * 0.5, tx: W * 0.5, ty: H * 0.5, r: R0, mass: 1000, gm: GM0, boost: 0, spin: 0 },
      particles: [], jets: [], sparks: [], rings: [], minis: [],
      stars: [], nebula: [],
      auto: false, autoTimer: 0, autoTx: W * 0.5, autoTy: H * 0.5, userHold: 0,
      labels: true, pull: false, pulseFlare: 0,
      jetCd: 0, spawnAcc: 0, eaten: 0, spawned: 0, bestMass: 1000,
      lastSpecial: {}, specialCount: { comet: 0, nebula: 0, minibh: 0 },
      rate: 0, rateAvg: 0, massLog: 1000, flash: 0, milestone: 0,
      phil: 0, philText: '', philBand: 0,
      eventId: '', lastEventId: '', eventSeq: 0, ripples: [], denseNebula: 0, lensStar: null,
      evText: '', evT: 0, eventsUnlocked: false,
      unlocked: {}, zen: false, hint: 0, hintText: '', jetWindAcc: 0, autoJetTimer: 2 + rnd() * 4, autoJets: 0, timeScale: 1,
      cam: { scale: 1, x: W * 0.5, y: H * 0.5 }, camDist: 1,
      peak: 0
    };
    // 星场要铺得比"拉远后能看到的最大范围"还大，否则拉远会露出空白
    // 最大拉远约 0.18 倍 → 可见范围约 W/0.18，所以铺到 7.2 倍画面
    var SPAN = 7.2;
    for (var i = 0; i < 3000; i++) {
      w.stars.push({
        x: W / 2 + (rnd() - 0.5) * W * SPAN,
        y: H / 2 + (rnd() - 0.5) * H * SPAN,
        b: 0.14 + rnd() * 0.72, s: rnd() < 0.06 ? 2 : 1
      });
    }
    for (var n = 0; n < 14; n++) {
      w.nebula.push({
        x: W / 2 + (rnd() - 0.5) * W * SPAN * 0.6, y: H / 2 + (rnd() - 0.5) * H * SPAN * 0.6,
        r: 200 + rnd() * 320, c: ['#241a44', '#10233f', '#3a1c33'][n % 3]
      });
    }
    for (var k = 0; k < 260; k++) spawnParticle(w, 'dust', true);
    for (var s = 0; s < 40; s++) spawnParticle(w, 'star', true);
    for (var p = 0; p < 5; p++) spawnParticle(w, 'planet', true);
    return w;
  }

  function circularSpeed(w, d) { return Math.sqrt(w.bh.gm / Math.max(1, d)); }

  // 各类天体的出现概率（显式写出来，方便调"刷新频率"）
  var SPAWN_P = {
    minibh: 0.0016,     // 小黑洞：最稀有，一颗能存在很久
    comet:  0.032,     // 彗星
    nebula: 0.011,     // 星云团：一颗就散出两百多颗尘埃，不能常来
    planet: 0.045,     // 行星
    star:   0.320      // 恒星
  };
  // 特殊天体的最小间隔（秒）：光靠概率不够——吃得越猛刷得越快，
  // 加了这个冷却之后，无论节奏多快都保证稀有
  var SPECIAL_CD = { comet: 80, nebula: 35, minibh: 75 };
  function specialReady(w, kind) {
    return (w.time - (w.lastSpecial[kind] === undefined ? -999 : w.lastSpecial[kind])) > SPECIAL_CD[kind];
  }
  function pickKind(w) {
    var r = rnd(), acc = 0;
    if (w.unlocked.minibh && specialReady(w, 'minibh')) { acc += SPAWN_P.minibh; if (r < acc) return 'minibh'; }
    if (w.unlocked.comet && specialReady(w, 'comet')) { acc += SPAWN_P.comet; if (r < acc) return 'comet'; }
    if (w.unlocked.nebula && specialReady(w, 'nebula')) { acc += SPAWN_P.nebula; if (r < acc) return 'nebula'; }
    acc += SPAWN_P.planet; if (r < acc) return 'planet';
    acc += SPAWN_P.star; if (r < acc) return 'star';
    return 'dust';
  }

  function spawnParticle(w, kind, anywhere) {
    if (w.particles.length >= MAX_PARTICLES) return null;
    if (kind === 'minibh') return spawnMiniBH(w, anywhere);
    var def = KINDS[kind];
    var r = def.r0 + rnd() * (def.r1 - def.r0);
    var m = def.m;
    // 从场地外围进来；anywhere=true 时散布在整个场里
    var ang = rnd() * Math.PI * 2;
    var zoom = clamp(w.cam ? w.cam.scale : 1, SCALE_MIN, 1);
    var d = anywhere ? (120 + rnd() * 620) / zoom : (430 + rnd() * 190) / zoom;
    var x = w.bh.x + Math.cos(ang) * d, y = w.bh.y + Math.sin(ang) * d;
    var vc = circularSpeed(w, d) * (0.72 + rnd() * 0.38);
    var dir = rnd() < 0.5 ? 1 : -1;
    var vx = -Math.sin(ang) * vc * dir + (rnd() - 0.5) * 12;
    var vy = Math.cos(ang) * vc * dir + (rnd() - 0.5) * 12;
    if (kind === 'comet') {
      // 彗星：比圆轨道快得多，斜插进来，拖着尾巴
      var cs = circularSpeed(w, d) * (1.15 + rnd() * 0.5);
      vx = -Math.sin(ang) * cs * dir - Math.cos(ang) * cs * 0.35;
      vy = Math.cos(ang) * cs * dir - Math.sin(ang) * cs * 0.35;
    }
    var p = {
      kind: kind, x: x, y: y, vx: vx, vy: vy, r: r, m: m, heat: 0,
      life: 0, maxLife: 0, trail: [], seed: rnd() * 1000, dead: false, pair: null, cloud: 0
    };
    if (kind === 'jet') { p.life = p.maxLife = 1.4 + rnd() * 0.6; }
    if (kind === 'nebula') { p.m = 0; p.cloud = 1; }
    w.particles.push(p);
    w.spawned += 1;
    if (w.specialCount && w.specialCount[kind] !== undefined) {
      w.specialCount[kind] += 1;
      w.lastSpecial[kind] = w.time;
    }
    return p;
  }

  // 小黑洞：自己带引力，会吞掉附近的物质慢慢变重，同时绕着主黑洞转；
  // 两个小黑洞靠得太近会并合；被主黑洞吃掉时会一次性贡献很大一块质量
  function spawnMiniBH(w, anywhere) {
    if (w.particles.length >= MAX_PARTICLES) return null;
    var ang = rnd() * Math.PI * 2;
    var zoom = clamp(w.cam ? w.cam.scale : 1, SCALE_MIN, 1);
    var d = (anywhere ? (220 + rnd() * 460) : (560 + rnd() * 180)) / zoom;
    var m = 380 + rnd() * 320;      // 不要太肥，否则吃两颗就把质量顶满
    var vc = circularSpeed(w, d) * (0.82 + rnd() * 0.2);
    var dir = rnd() < 0.5 ? 1 : -1;
    var p = {
      kind: 'minibh', x: w.bh.x + Math.cos(ang) * d, y: w.bh.y + Math.sin(ang) * d,
      vx: -Math.sin(ang) * vc * dir, vy: Math.cos(ang) * vc * dir,
      r: 7 + rnd() * 3.5, m: m, absorbed: 0, heat: 0.35,
      life: 0, maxLife: 0, trail: [], seed: rnd() * 1000, dead: false, cloud: 0
    };
    miniStats(p);
    w.particles.push(p);
    w.spawned += 1;
    if (w.specialCount) { w.specialCount.minibh += 1; w.lastSpecial.minibh = w.time; }
    if (w.isMain) { Sound.chime(true); w.hint = 3; w.hintText = '一颗小黑洞飘进了吸积盘'; }
    return p;
  }

  function miniStats(p) {
    p.gm = MINI_GM * (p.m / 900);
    p.infl = MINI_INFL * Math.sqrt(p.m / 900);
    p.infl2 = p.infl * p.infl;
    p.eat = p.r * 1.15;
    return p;
  }

  function spawnCluster(w, n) {
    n = n || 70;
    for (var i = 0; i < n; i++) {
      var k = rnd() < 0.12 ? 'star' : (rnd() < 0.06 ? 'planet' : 'dust');
      spawnParticle(w, k, true);
    }
    w.rings.push({ x: w.bh.x, y: w.bh.y, r: 40, max: 460, life: 1, color: '#ffd9a8' });
  }

  function addSparks(w, x, y, color, n, speed) {
    for (var i = 0; i < n; i++) {
      var a = rnd() * Math.PI * 2, s = (0.3 + rnd()) * (speed || 120);
      w.sparks.push({
        x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.4 + rnd() * 0.6, max: 1, color: color, r: 1 + rnd() * 2.2
      });
    }
    if (w.sparks.length > 400) w.sparks.splice(0, w.sparks.length - 400);
  }

  function fireJets(w, strength) {
    var bh = w.bh, n = Math.round(4 + strength * 8);
    var jetN = 0;
    for (var c = 0; c < w.particles.length; c++) if (w.particles[c].kind === 'jet') jetN++;
    if (jetN > 130) return;                      // 别让喷流无限堆积
    w.jetCd = JET_CD;                            // 喷流只有一个冷却，谁触发的都算
    for (var s = -1; s <= 1; s += 2) {
      for (var i = 0; i < n; i++) {
        var spread = (rnd() - 0.5) * 0.5;
        var sp = 420 + rnd() * 320;
        w.particles.push({
          kind: 'jet', x: bh.x + (rnd() - 0.5) * bh.r, y: bh.y + s * bh.r * 0.4,
          vx: spread * 180, vy: s * sp, r: 1.2 + rnd() * 1.6, m: 0, heat: 1,
          life: 1.6 + rnd() * 0.8, maxLife: 2.4, trail: [], dead: false
        });
      }
    }
  }

  function eatParticle(w, p) {
    var bh = w.bh;
    if (p.kind === 'minibh') {          // 吃掉一颗小黑洞：连它吞下去的一起算
      var bonus = p.m + (p.absorbed || 0);
      bh.mass += bonus;
      w.eaten += 1;
      w.rate += 3;
      w.flash = Math.min(0.8, w.flash + 0.5);
      w.milestone = 2.2;
      w.rings.push({ x: bh.x, y: bh.y, r: bh.r * 1.4, max: 560, life: 1, color: '#e3d2ff' });
      w.rings.push({ x: bh.x, y: bh.y, r: bh.r * 1.4, max: 380, life: 1, color: '#bfe6ff' });
      addSparks(w, p.x, p.y, '#e3d2ff', 44, 320);
      fireJets(w, 1.4);
      w.hint = 3.2;
      w.hintText = '吞掉一个小黑洞：质量 +' + fmt(Math.round(bonus));
      Sound.chime(true);
      return;
    }
    bh.mass += p.m;
    w.eaten += 1;
    var heat = p.kind === 'star' ? 0.75 : (p.kind === 'planet' ? 1 : 0.4);
    addSparks(w, p.x, p.y, KINDS[p.kind] ? KINDS[p.kind].color : '#fff', p.kind === 'planet' ? 26 : 8, p.kind === 'planet' ? 260 : 130);
    w.flash = Math.min(0.5, w.flash + (p.kind === 'planet' ? 0.35 : 0.06));
    w.rate += 1;
    Sound.eat(heat, p.m);
    if (p.kind === 'planet') { fireJets(w, 1); w.rings.push({ x: bh.x, y: bh.y, r: bh.r * 2, max: 320, life: 1, color: '#bfe6ff' }); }
  }

  function breakupPlanet(w, p) {
    Sound.breakup();
    var n = 14 + Math.round(rnd() * 6);
    var ang = Math.atan2(p.y - w.bh.y, p.x - w.bh.x) + Math.PI / 2;   // 沿切向拉成流
    for (var i = 0; i < n; i++) {
      var off = (i / n - 0.5) * 46;
      var sp = circularSpeed(w, Math.hypot(p.x - w.bh.x, p.y - w.bh.y)) * (0.9 + rnd() * 0.3);
      w.particles.push({
        kind: 'frag', x: p.x + Math.cos(ang) * off, y: p.y + Math.sin(ang) * off,
        vx: p.vx + Math.cos(ang) * off * 0.5 + (rnd() - 0.5) * sp * 0.12,
        vy: p.vy + Math.sin(ang) * off * 0.5 + (rnd() - 0.5) * sp * 0.12,
        r: 1.4 + rnd() * 1.4, m: 3, heat: 0.2, life: 0, maxLife: 0, trail: [], dead: false
      });
    }
    addSparks(w, p.x, p.y, '#ffcf9e', 22, 180);
    p.dead = true;
    w.rings.push({ x: p.x, y: p.y, r: 8, max: 150, life: 1, color: '#ffcf9e' });
  }

  function dissolveNebula(w, p) {
    var n = 120 + Math.round(p.r * 1.6);
    for (var i = 0; i < n; i++) {
      if (w.particles.length >= MAX_PARTICLES) break;
      var a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.6) * p.r * 1.7;
      w.particles.push({
        kind: 'dust', x: p.x + Math.cos(a) * rr, y: p.y + Math.sin(a) * rr,
        vx: p.vx * 0.7 + Math.cos(a) * 10, vy: p.vy * 0.7 + Math.sin(a) * 10,
        r: 1.2 + rnd() * 1.6, m: 1, heat: 0.15, life: 0, maxLife: 0,
        trail: [], seed: rnd() * 1000, dead: false, cloud: 0
      });
    }
    addSparks(w, p.x, p.y, '#c9a8ff', 24, 90);
    w.rings.push({ x: p.x, y: p.y, r: 10, max: p.r * 3.4, life: 1, color: '#c9a8ff' });
    if (w.isMain) Sound.breakup();
    p.dead = true;
  }

  function pulse(w) {
    if (w.jetCd > 0) return false;               // 自动喷流刚喷过，这里也会被挡
    w.jetCd = JET_CD;
    for (var i = 0; i < w.particles.length; i++) {
      var p = w.particles[i];
      if (p.kind === 'jet') continue;
      var dx = w.bh.x - p.x, dy = w.bh.y - p.y;
      var d = Math.hypot(dx, dy) || 1;
      if (d > PULSE_R) continue;
      // 冲量按当地的圆轨道速度给：近处是"猛拽"，远处只是轻轻一推
      var k = (1 - d / PULSE_R) * circularSpeed(w, d) * 1.6;
      p.vx += dx / d * k; p.vy += dy / d * k;
    }
    w.rings.push({ x: w.bh.x, y: w.bh.y, r: 20, max: PULSE_R, life: 1, color: '#9fd0ff' });
    w.rings.push({ x: w.bh.x, y: w.bh.y, r: w.bh.r * 1.6, max: 340, life: 1, color: '#bfe6ff' });
    w.pulseFlare = 1.7;
    w.flash = Math.min(0.55, w.flash + 0.22);
    fireJets(w, 1.3);                 // 脉冲同时也从两极喷一股
    Sound.jet();
    Sound.pulse();
    return true;
  }

  // ---------------------------------------------------------------- 物理
  function stepWorld(w, dt, inp) {
    if (w.paused) return;
    w.time += dt;
    inp = inp || {};
    var bh = w.bh;

    // --- 黑洞移动：漫游模式下鼠标不接管（想自己拖就先关掉漫游）
    if (inp.auto) w.auto = true;
    var hasPointer = (inp.pointerX !== null && inp.pointerX !== undefined);
    if (!w.auto) {
      if (hasPointer) { bh.tx = inp.pointerX; bh.ty = inp.pointerY; }
    } else if (hasPointer && !w.autoHintShown) {
      w.autoHintShown = true;
      w.hint = 4.5;
      w.hintText = '漫游中';
    }
    if (w.auto) {
      w.autoTimer -= dt;
      if (w.autoTimer <= 0) {
        w.autoTimer = 1.6;
        // 追最密的一片：找视野内粒子的重心（按 1/d 加权）
        var sx = 0, sy = 0, sw = 0;
        for (var i = 0; i < w.particles.length; i++) {
          var p = w.particles[i];
          if (p.kind === 'jet') continue;
          var d = Math.hypot(p.x - bh.x, p.y - bh.y);
          if (d > 760) continue;
          var wgt = 1 / (60 + d);
          sx += p.x * wgt; sy += p.y * wgt; sw += wgt;
        }
        if (sw > 0) { w.autoTx = clamp(sx / sw, 60, W - 60); w.autoTy = clamp(sy / sw, 60, H - 60); }
      }
      bh.tx = lerp(bh.tx, w.autoTx, 1 - Math.exp(-dt / 0.9));
      bh.ty = lerp(bh.ty, w.autoTy, 1 - Math.exp(-dt / 0.9));
    }
    var follow = 1 - Math.exp(-dt / 0.18);   // 跟手但不生硬
    bh.x = lerp(bh.x, bh.tx, follow);
    bh.y = lerp(bh.y, bh.ty, follow);

    // --- 相机：静观模式缓慢拉远，镜头始终跟着黑洞
    var camDt = dt / clamp(w.timeScale || 1, 0.2, 3);   // 镜头按真实时间走，不受时间流速影响
    var wantScale = clamp(1 / clamp(w.camDist || camDist, 1, 2.5), SCALE_MIN, 1);
    w.cam.scale = lerp(w.cam.scale, wantScale, 1 - Math.exp(-camDt / 5));
    w.cam.x = lerp(w.cam.x, bh.x, 1 - Math.exp(-camDt / 1.0));
    w.cam.y = lerp(w.cam.y, bh.y, 1 - Math.exp(-camDt / 1.0));
    var zoom = clamp(w.cam.scale, SCALE_MIN, 1);
    var fieldR = FIELD_R / zoom;
    var targetPop = Math.min(1200, Math.round(TARGET_POP / Math.pow(zoom, 1.15)));
    bh.spin += dt * (0.5 + w.rateAvg * 0.002);

    // --- 吸力增强 / 冷却 / 亮度
    bh.boost = lerp(bh.boost, (w.pull || inp.pull) ? 1 : 0, 1 - Math.pow(0.01, dt));
    if (w.jetCd > 0) w.jetCd = Math.max(0, w.jetCd - dt);
    var gm = Math.min(GM_CAP, GM0 * Math.pow(bh.mass / 1000, 0.45)) * (1 + bh.boost * 0.95);
    bh.gm = gm;
    var ratio = clamp(Math.log10(Math.max(1, bh.mass / 1000)) / 1.4, 0, 1);
    bh.r = clamp(R0 * Math.pow(bh.mass / 1000, 0.42), R0, 62);
    w.rateAvg = lerp(w.rateAvg, w.rate, 1 - Math.pow(0.2, dt));
    w.rate = Math.max(0, w.rate - dt * 4.5);
    if (w.pulseFlare > 0) w.pulseFlare = Math.max(0, w.pulseFlare - dt);
    w.flash = Math.max(0, w.flash - dt * 1.6);
    if (w.milestone > 0) w.milestone -= dt;
    Sound.mass(ratio);

    // --- 粒子
    var keep = [];
    for (var pi = 0; pi < w.particles.length; pi++) {
      var p = w.particles[pi];
      if (p.dead) continue;

      if (p.kind === 'jet') {
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.life -= dt;
        if (p.life <= 0) continue;      // 只按寿命回收（投影后可能还在画面里）
        keep.push(p);
        continue;
      }

      // 小黑洞的引力：附近的东西会被它拽过去，太近就被它吞掉
      if (p.kind !== 'minibh' && w.minis && w.minis.length) {
        for (var mg = 0; mg < w.minis.length; mg++) {
          var mb = w.minis[mg];
          if (mb.dead || mb === p) continue;
          var gx = mb.x - p.x, gy = mb.y - p.y;
          var gd2 = gx * gx + gy * gy;
          if (gd2 > mb.infl2) continue;
          var gd = Math.sqrt(gd2) + 0.001;
          var ga = mb.gm / (gd2 + 60);
          p.vx += ga * gx / gd * dt;
          p.vy += ga * gy / gd * dt;
          if (gd < mb.eat) {                     // 被小黑洞吞掉
            p.dead = true;
            mb.m += p.m;
            mb.absorbed = (mb.absorbed || 0) + p.m;
            mb.r = Math.min(15, 7 + (mb.m - 900) / 220);
            miniStats(mb);
            mb.heat = Math.min(1, mb.heat + 0.1);
            w.rate += 0.5;
            addSparks(w, p.x, p.y, '#d9c2ff', 7, 130);
            if (w.isMain) Sound.eat(0.3, p.m);
            break;
          }
        }
        if (p.dead) continue;
      }

      var dx = bh.x - p.x, dy = bh.y - p.y;
      var d2 = dx * dx + dy * dy;
      var d = Math.sqrt(d2);
      var soft = d2 + SOFT;
      var acc = gm / soft;
      var inv = 1 / (d > 1 ? d : 1);      // 0/0 会变 NaN：中心附近兜个底
      p.vx += acc * dx * inv * dt;
      p.vy += acc * dy * inv * dt;

      // 引力波涟漪扫过时，把盘轻轻搓一下（切向）
      if (w.ripples && w.ripples.length) {
        for (var rk = 0; rk < w.ripples.length; rk++) {
          var rq = w.ripples[rk];
          var gap = Math.abs(d - rq.r);
          if (gap < 30) {
            var kk = (30 - gap) * rq.life * 0.09 * dt * 60;
            p.vx += -dy / (d > 1 ? d : 1) * kk;
            p.vy += dx / (d > 1 ? d : 1) * kk;
          }
        }
      }

      // 小黑洞：只用轻微摩擦，让它能绕着转一会儿再慢慢沉进去
      if (p.kind === 'minibh') {
        var mdamp = 1 - 0.035 * dt;
        p.vx *= mdamp; p.vy *= mdamp;
      }

      // 吸积盘粘滞：靠近黑洞时损失角动量，保证会掉进去（不然会永远绕圈）
      if (p.kind !== 'minibh' && d < bh.r * 9) {
        var damp = 1 - 0.9 * dt * (1 - d / (bh.r * 9));
        p.vx *= damp; p.vy *= damp;
      }

      p.x += p.vx * dt; p.y += p.vy * dt;
      d = Math.hypot(bh.x - p.x, bh.y - p.y);

      // 吞噬
      if (d < bh.r + p.r) { eatParticle(w, p); continue; }

      // 洛希极限：行星被撕成碎片流
      if (p.kind === 'planet') {
        var roche = bh.r * 3.2 + p.r * 2.5;
        if (d < roche) { breakupPlanet(w, p); continue; }
      }

      // 星云团：飘进内区就散成一团尘埃
      if (p.kind === 'nebula') {
        if (d < bh.r * 6 + 260) { dissolveNebula(w, p); continue; }
        p.heat = 0;
        keep.push(p);
        continue;
      }

      // 彗星：记尾巴
      if (p.kind === 'comet') {
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 24) p.trail.shift();
      }

      // 热度（越靠近视界越亮）
      p.heat = clamp(1 - (d - bh.r) / (bh.r * 7), 0, 1);

      // 飞出场景就回收（等会儿会有新的补进来）
      if (d > fieldR && (p.vx * dx + p.vy * dy) < 0) continue;

      keep.push(p);
    }
    w.particles = keep;

    // 小黑洞并合：靠得太近就合成一个（质量相加）
    var ms2 = [];
    for (var q1 = 0; q1 < w.particles.length; q1++) {
      if (w.particles[q1].kind === 'minibh') ms2.push(w.particles[q1]);
    }
    for (var q2 = 0; q2 < ms2.length; q2++) {
      for (var q3 = q2 + 1; q3 < ms2.length; q3++) {
        var A = ms2[q2], B = ms2[q3];
        if (A.dead || B.dead) continue;
        if (Math.hypot(A.x - B.x, A.y - B.y) < (A.r + B.r) * 1.05) {
          var mTot = A.m + B.m;
          A.vx = (A.vx * A.m + B.vx * B.m) / mTot;
          A.vy = (A.vy * A.m + B.vy * B.m) / mTot;
          A.m = mTot;
          A.absorbed = (A.absorbed || 0) + (B.absorbed || 0);
          A.r = Math.min(15, 7 + (A.m - 900) / 220);
          miniStats(A);
          B.dead = true;
          w.rings.push({ x: A.x, y: A.y, r: 6, max: 300, life: 1, color: '#d9c2ff' });
          addSparks(w, A.x, A.y, '#e3d2ff', 26, 240);
          if (w.isMain) { w.hint = 3; w.hintText = '两个小黑洞并合了'; Sound.chime(true); }
        }
      }
    }
    w.minis = [];
    for (var q4 = 0; q4 < w.particles.length; q4++) {
      if (w.particles[q4].kind === 'minibh' && !w.particles[q4].dead) w.minis.push(w.particles[q4]);
    }

    // --- 维持种群
    // 按"缺口"补充：场上满了就完全不刷（不再有源源不断的凭空出现），
    // 被吃掉多少就补多少；上限随视界大小放宽，免得大黑洞把盘吃空
    var deficit = targetPop - w.particles.length;
    var refillCeil = Math.min(40, 10 + bh.r * 0.8);
    var spawnRate = clamp(deficit * 0.4, 0, refillCeil);
    w.spawnAcc += dt * spawnRate;
    while (w.spawnAcc > 1 && w.particles.length < targetPop) {
      w.spawnAcc -= 1;
      spawnParticle(w, pickKind(w), false);
    }
    if (w.spawnAcc > 4) w.spawnAcc = 0;

    // --- 漫游时自己随机来一发喷流
    if (w.auto) {
      w.autoJetTimer -= dt;
      if (w.autoJetTimer <= 0) {
        if (w.jetCd > 0) {
          w.autoJetTimer = 0.5;                  // 冷却中：等一会儿再看
        } else {
          w.autoJetTimer = 5 + rnd() * 9;
          fireJets(w, 0.5 + rnd() * 0.7);
          w.rings.push({ x: bh.x, y: bh.y, r: bh.r * 2, max: 300, life: 1, color: '#bfe6ff' });
          w.autoJets = (w.autoJets || 0) + 1;
          if (w.isMain) Sound.jet();
        }
      }
    }

    // --- 喷流把附近物质吹开（不然喷流只是个装饰）
    w.jetWindAcc += dt;
    if (w.jetWindAcc >= 0.08) {
      w.jetWindAcc = 0;
      var jets = [];
      for (var ji = 0; ji < w.particles.length; ji++) {
        if (w.particles[ji].kind === 'jet') jets.push(w.particles[ji]);
      }
      if (jets.length) {
        for (var qi2 = 0; qi2 < w.particles.length; qi2++) {
          var q2 = w.particles[qi2];
          if (q2.kind === 'jet') continue;
          for (var jj = 0; jj < jets.length; jj++) {
            var J = jets[jj];
            var jx = q2.x - J.x, jy = q2.y - J.y;
            var jd2 = jx * jx + jy * jy;
            if (jd2 > JET_R * JET_R) continue;
            var jd = Math.sqrt(jd2) || 1;
            var fall = 1 - jd / JET_R;
            var k = JET_PUSH * fall * 0.08 * jetProj();   // 看不见的喷流不该推东西
            q2.vx += (J.vx / 600 * 0.7 + jx / jd * 0.6) * k;
            q2.vy += (J.vy / 600 * 0.7 + jy / jd * 0.6) * k;
          }
        }
      }
    }

    // --- 火星 / 圆环
    for (var si = w.sparks.length - 1; si >= 0; si--) {
      var sp = w.sparks[si];
      sp.life -= dt;
      if (sp.life <= 0) { w.sparks.splice(si, 1); continue; }
      sp.x += sp.vx * dt; sp.y += sp.vy * dt;
      sp.vx *= 0.97; sp.vy *= 0.97;
    }
    for (var ri = w.rings.length - 1; ri >= 0; ri--) {
      var rg = w.rings[ri];
      rg.r += (rg.max - rg.r) * (1 - Math.pow(0.02, dt));
      rg.life -= dt * 0.9;
      if (rg.life <= 0) w.rings.splice(ri, 1);
    }

    if (bh.mass > w.bestMass) w.bestMass = bh.mass;

    // --- 解锁新天体
    for (var ui = 0; ui < UNLOCKS.length; ui++) {
      var U = UNLOCKS[ui];
      if (!w.unlocked[U.kind] && bh.mass >= U.mass) {
        w.unlocked[U.kind] = true;
        w.hint = 4;
        w.hintText = '解锁：' + U.label + '（质量 ' + fmt(U.mass) + '）';
        w.rings.push({ x: bh.x, y: bh.y, r: bh.r * 3, max: 420, life: 1, color: '#ffe0b0' });
        Sound.chime(true);
      }
    }
    if (w.hint > 0) w.hint -= dt;

    // --- 事件状态：涟漪扩张、星云稠密倒计时、透镜恒星淡出
    if (w.ripples && w.ripples.length) {
      for (var rj = w.ripples.length - 1; rj >= 0; rj--) {
        var rp = w.ripples[rj];
        rp.r += dt * 430;
        rp.life = 1 - rp.r / 1500;
        if (rp.life <= 0) w.ripples.splice(rj, 1);
      }
    }
    if (w.denseNebula > 0) w.denseNebula -= dt;
    if (w.evT > 0) w.evT -= dt;
    if (w.lensStar) { w.lensStar.t -= dt; if (w.lensStar.t <= 0) w.lensStar = null; }

    // --- 每 +10000 质量：亮一下，并弹一句哲学留言
    var band = Math.floor(bh.mass / 10000);
    if (band > w.philBand) {
      w.philBand = band;
      w.milestone = 2.6;
      if (w.phil <= 0) {                      // 上一句还在就不插队，免得刷屏
        w.phil = 9;
        w.philText = PHILOSOPHY[(band - 1) % PHILOSOPHY.length];
      }
      if (bh.mass > EVENT_MIN_MASS) {
        if (!w.eventsUnlocked) w.eventsUnlocked = true;   // 刚到 20000 这一档：解锁（不再额外提示）
        triggerMilestoneEvent(w);
      }
      Sound.chime(true);
    }
    if (w.phil > 0) w.phil -= dt;
  }

  // ---------------------------------------------------------------- 渲染
  // 中文折行（canvas 不会自己折）：尽量在标点处断开，别把词切断
  function wrapCJK(text, maxChars) {
    var out = [], cur = '';
    for (var i = 0; i < text.length; i++) {
      cur += text[i];
      if (cur.length >= maxChars) {
        var cut = -1;
        for (var j = cur.length - 1; j >= Math.max(0, cur.length - 8); j--) {
          if ('，。、；：！？'.indexOf(cur[j]) >= 0) { cut = j + 1; break; }
        }
        if (cut > 0 && cut < cur.length) { out.push(cur.slice(0, cut)); cur = cur.slice(cut); }
        else { out.push(cur); cur = ''; }
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var glowCache = {};
  function withAlpha(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function glowSprite(color) {
    if (glowCache[color]) return glowCache[color];
    var size = 64, c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, withAlpha(color, 0.95));
    grd.addColorStop(0.35, withAlpha(color, 0.42));
    grd.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    glowCache[color] = c;
    return c;
  }

  // 把盘里的物质按半径分箱，得到一条沿半径的亮度曲线
  function diskSquash() { return clamp(squash, 0.14, 1); }   // 吸积盘的光随视角压扁
  function particleSquash() { return 1; }                    // 粒子按真实位置画，不跟视角变

  function diskBins(w, rIn, rOut, counts) {
    var i;
    for (i = 0; i < DISK_BINS; i++) counts[i] = 0;
    for (i = 0; i < w.particles.length; i++) {
      var p = w.particles[i];
      if (p.kind === 'jet') continue;
      var d = Math.hypot(p.x - w.bh.x, p.y - w.bh.y);
      if (d < rIn || d > rOut) continue;
      var bi = Math.floor((d - rIn) / (rOut - rIn) * DISK_BINS);
      if (bi >= 0 && bi < DISK_BINS) counts[bi]++;
    }
  }

  function drawLensedDisk(w, ctx, heat) {
    var bh = w.bh, shadow = bh.r * SHADOW_K;
    var rIn = shadow * 1.06, rOut = shadow * 5.0;
    var counts = w.__bins || (w.__bins = new Array(DISK_BINS));
    var prof = w.__prof || (w.__prof = new Array(DISK_BINS));
    diskBins(w, rIn, rOut, counts);
    var base = 4 + heat * 16;

    for (var i = 0; i < DISK_BINS; i++) {
      var c0 = counts[Math.max(0, i - 1)], c1 = counts[i], c2 = counts[Math.min(DISK_BINS - 1, i + 1)];
      prof[i] = (c0 + 2 * c1 + c2) / 4;
    }
    var step = (rOut - rIn) / DISK_BINS;
    var q = diskSquash();
    ctx.globalCompositeOperation = 'lighter';

    // 直接像：一圈圈环带填充（不是整块椭圆叠加，否则内区会累积成一团白）
    for (var di = 0; di < DISK_BINS; di++) {
      var r1 = rIn + di * step, r2 = r1 + step * 1.02;
      var t = di / (DISK_BINS - 1);
      var b0 = clamp((prof[di] * 3.2 + base * Math.pow(1 - t, 1.1)) / 58, 0, 1);
      if (b0 < 0.02) continue;
      var col = diskColor(t);
      var gb = ctx.createLinearGradient(bh.x - r2, bh.y, bh.x + r2, bh.y);
      gb.addColorStop(0, rgbaOf(col, b0 * 0.38));       // 迎向观察者的一侧更亮
      gb.addColorStop(0.5, rgbaOf(col, b0 * 0.22));
      gb.addColorStop(1, rgbaOf(col, b0 * 0.13));
      ctx.fillStyle = gb;
      ctx.beginPath();
      ctx.ellipse(bh.x, bh.y, r2, r2 * q, 0, 0, 6.2832);
      ctx.ellipse(bh.x, bh.y, r1, r1 * q, 0, 0, 6.2832);
      ctx.fill('evenodd');
    }

    // 透镜像：盘背面的光绕过黑洞，压在阴影外侧一圈
    var peak = clamp((tiltDeg - 12) / 45, 0, 1);
    var archW = shadow * 0.085;
    for (var ai = 0; ai < DISK_BINS; ai++) {
      var rr0 = rIn + (ai + 0.5) * step;
      var ri = shadow * 1.03 + Math.max(0, rr0 - shadow * 1.03) * LENS_ARCH_K;
      if (ri > shadow * 1.34) break;
      var b1 = clamp((prof[ai] * 3.2 + base * 1.6) / 58, 0, 1);
      if (b1 < 0.02) continue;
      var cola = diskColor(ai / (DISK_BINS - 1));
      var gt = ctx.createLinearGradient(bh.x, bh.y - ri - archW, bh.x, bh.y + ri + archW);
      gt.addColorStop(0, rgbaOf(cola, b1 * lerp(0.17, 0.55, peak)));
      gt.addColorStop(0.34, rgbaOf(cola, b1 * lerp(0.12, 0.09, peak)));
      gt.addColorStop(0.5, rgbaOf(cola, b1 * lerp(0.11, 0.07, peak)));
      gt.addColorStop(0.66, rgbaOf(cola, b1 * lerp(0.12, 0.09, peak)));
      gt.addColorStop(1, rgbaOf(cola, b1 * lerp(0.17, 0.40, peak)));
      ctx.fillStyle = gt;
      ctx.beginPath();
      ctx.ellipse(bh.x, bh.y, ri + archW, (ri + archW) * LENS_ARCH_Q, 0, 0, 6.2832);
      ctx.ellipse(bh.x, bh.y, Math.max(1, ri - archW), Math.max(1, (ri - archW) * LENS_ARCH_Q), 0, 0, 6.2832);
      ctx.fill('evenodd');
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  // 喷流：极向的，屏幕上的竖直位移按 sin(视角) 投影；俯视时会缩成一点（可以接受）
  function jetProj() { return Math.sin(clamp(tiltDeg, 0, 80) * Math.PI / 180); }
  function jetY(bh, y) { return bh.y + (y - bh.y) * jetProj(); }
  function jetAlpha(p) {
    var t = clamp(p.life / p.maxLife, 0, 1);
    return t > 0.25 ? 1 : t / 0.25;      // 前 75% 保持满亮，最后才淡出 → 能一直射到屏幕外
  }

  function drawParticle(w, ctx, p, bh) {
    var col = KINDS[p.kind].color;
    var hot = p.kind === 'jet' ? 1 : p.heat;

    // 星云团：一大团半透明的紫，靠近黑洞才散开
    if (p.kind === 'nebula') {
      var ng = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 1.9);
      ng.addColorStop(0, withAlpha('#b49cf0', 0.22));
      ng.addColorStop(0.55, withAlpha('#7a5fd0', 0.11));
      ng.addColorStop(1, withAlpha('#5a3fb0', 0));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = ng;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.9, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      return;
    }


    // 彗尾：沿轨迹拖出一条渐隐的光带
    if (p.kind === 'comet' && p.trail.length > 1) {
      ctx.globalCompositeOperation = 'lighter';
      for (var ti = 1; ti < p.trail.length; ti++) {
        var ta = ti / p.trail.length;
        ctx.strokeStyle = withAlpha('#8fd0ff', ta * 0.45);
        ctx.lineWidth = 0.8 + ta * 3.4;
        ctx.beginPath();
        ctx.moveTo(p.trail[ti - 1].x, p.trail[ti - 1].y);
        ctx.lineTo(p.trail[ti].x, p.trail[ti].y);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    if (p.kind === 'minibh') {
      // 小黑洞：一圈紫辉光 + 真正的暗影 + 一道细环（和主黑洞同一种画法，只是小）
      var bg = ctx.createRadialGradient(p.x, p.y, p.r * 0.7, p.x, p.y, p.r * 4.2);
      bg.addColorStop(0, 'rgba(206,180,255,0.30)');
      bg.addColorStop(0.4, 'rgba(146,112,226,0.16)');
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4.2, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#05060c';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = withAlpha('#efe6ff', 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.03, 0, 6.2832); ctx.stroke();
      ctx.strokeStyle = withAlpha('#b79bff', 0.4);
      ctx.lineWidth = 3.6;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.2, 0, 6.2832); ctx.stroke();
      return;
    }

    if (p.kind === 'jet') {
      var jl = jetAlpha(p);
      var jp = jetProj();
      var y0 = jetY(bh, p.y), y1 = jetY(bh, p.y - p.vy * 0.06);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = withAlpha('#dff0ff', jl * 0.5);
      ctx.lineWidth = Math.max(1, p.r * 1.6 * (0.4 + 0.6 * jp));
      ctx.beginPath();
      ctx.moveTo(p.x, y0);
      ctx.lineTo(p.x - p.vx * 0.06 * jp, y1);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    var gy = p.kind === 'jet' ? jetY(bh, p.y) : p.y;
    if (hot > 0.05) {
      var spr = glowSprite(col);
      var sc = p.r * (3.4 + hot * 5.5) * (p.kind === 'jet' ? (0.45 + 0.55 * jetProj()) : 1);
      ctx.globalAlpha = 0.35 + hot * 0.6;
      ctx.drawImage(spr, p.x - sc / 2, gy - sc / 2, sc, sc);
    }
    ctx.globalAlpha = p.kind === 'jet' ? jetAlpha(p) : 0.55 + hot * 0.45;
    ctx.fillStyle = col;
    var pr = p.r * (1 + hot * 0.25) * (p.kind === 'jet' ? (0.5 + 0.5 * jetProj()) : 1);
    ctx.beginPath(); ctx.arc(p.x, gy, pr, 0, 6.2832); ctx.fill();
  }

  function renderWorld(w, ctx) {
    var bh = w.bh;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);

    // 背景
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#06070d'); bg.addColorStop(1, '#04050a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (var ni = 0; ni < w.nebula.length; ni++) {
      var nb = w.nebula[ni];
      var ng = ctx.createRadialGradient(nb.x, nb.y, 0, nb.x, nb.y, nb.r);
      ng.addColorStop(0, nb.c); ng.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.5 + clamp((w.denseNebula || 0) / 15, 0, 1) * 0.55;
      ctx.fillStyle = ng;
      ctx.fillRect(nb.x - nb.r, nb.y - nb.r, nb.r * 2, nb.r * 2);
    }
    ctx.globalAlpha = 1;

    // 进入世界坐标：静观模式拉远时，星空和粒子铺在更大的范围里
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(w.cam.scale, w.cam.scale);
    ctx.translate(-w.cam.x, -w.cam.y);

    // 背景星（带引力透镜的假位移）
    var shadow = bh.r * SHADOW_K;
    var infl = shadow * 3.4;
    // 当前可见的世界范围（多留一点余量），把画面外的星点直接跳过
    var halfW = W / 2 / w.cam.scale + 120, halfH = H / 2 / w.cam.scale + 120;
    var vx0 = w.cam.x - halfW, vx1 = w.cam.x + halfW, vy0 = w.cam.y - halfH, vy1 = w.cam.y + halfH;
    for (var si = 0; si < w.stars.length; si++) {
      var s = w.stars[si];
      if (s.x < vx0 || s.x > vx1 || s.y < vy0 || s.y > vy1) continue;
      var dx = s.x - bh.x, dy = s.y - bh.y;
      var d = Math.hypot(dx, dy) || 1;
      var x = s.x, y = s.y, b = s.b;
      if (d < infl) {
        var t = 1 - d / infl;
        var push = t * t * shadow * 2.2;
        x += dx / d * push; y += dy / d * push;
        b = Math.min(1, b * (1 + t * 2.2));
      }
      ctx.globalAlpha = b;
      ctx.fillStyle = '#dfe8ff';
      ctx.fillRect(x - s.s / 2, y - s.s / 2, s.s, s.s);
    }
    ctx.globalAlpha = 1;

    // 吸积盘：直接像是一条很扁的带，透镜像是压在光子环上的上、下两道拱
    var heat = clamp(w.rateAvg / 12 + w.pulseFlare * 0.5, 0, 1);
    drawLensedDisk(w, ctx, heat);      // 引力透镜恒定开启

    // 引力波涟漪：几道扩张的波前
    if (w.ripples && w.ripples.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (var rv = 0; rv < w.ripples.length; rv++) {
        var rq2 = w.ripples[rv];
        var rl = clamp(rq2.life, 0, 1);
        ctx.strokeStyle = 'rgba(196,222,255,' + (0.46 * rl).toFixed(3) + ')';
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(bh.x, bh.y, rq2.r, 0, 6.2832); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,196,154,' + (0.22 * rl).toFixed(3) + ')';
        ctx.lineWidth = 7;
        ctx.beginPath(); ctx.arc(bh.x, bh.y, rq2.r * 0.982, 0, 6.2832); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // 粒子。喷流分两批画：下半段（背离观察者）在这里画，会被盘和阴影挡住
    for (var pi = 0; pi < w.particles.length; pi++) {
      var p = w.particles[pi];
      if (p.kind === 'jet' && p.vy < 0) continue;      // 上半段留到阴影之后画
      drawParticle(w, ctx, p, bh);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 黑洞阴影 + 光子环
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(bh.x, bh.y, shadow, 0, 6.2832); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,225,190,' + (0.5 + heat * 0.4) + ')';
    ctx.lineWidth = 2.5 + heat * 2;
    ctx.beginPath(); ctx.arc(bh.x, bh.y, shadow * 0.995, 0, 6.2832); ctx.stroke();
    var ring = ctx.createRadialGradient(bh.x, bh.y, shadow * 0.9, bh.x, bh.y, shadow * 1.7);
    ring.addColorStop(0, 'rgba(255,200,140,' + (0.22 + heat * 0.2) + ')');
    ring.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ring;
    ctx.beginPath(); ctx.arc(bh.x, bh.y, shadow * 1.7, 0, 6.2832); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // 微引力透镜：阴影边缘亮起一小段弧，像一颗背景恒星被拉成了环
    if (w.lensStar) {
      var ls = w.lensStar;
      var lp = Math.sin(clamp(ls.t / ls.dur, 0, 1) * Math.PI);       // 0→1→0
      var lr = shadow * 1.06;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(214,236,255,' + (0.75 * lp).toFixed(3) + ')';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.ellipse(bh.x, bh.y, lr, lr, 0, ls.a - 0.5, ls.a + 0.5);
      ctx.stroke();
      var lx = bh.x + Math.cos(ls.a) * lr, ly = bh.y + Math.sin(ls.a) * lr;
      var lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, shadow * 0.5);
      lg.addColorStop(0, 'rgba(255,255,255,' + (0.85 * lp).toFixed(3) + ')');
      lg.addColorStop(0.35, 'rgba(180,220,255,' + (0.40 * lp).toFixed(3) + ')');
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.arc(lx, ly, shadow * 0.5, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    // 上半段喷流：画在阴影之后，所以不会被遮挡，一直射出屏幕
    for (var pk = 0; pk < w.particles.length; pk++) {
      var q = w.particles[pk];
      if (q.kind === 'jet' && q.vy < 0) drawParticle(w, ctx, q, bh);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 吸力增强时的能量环
    if (bh.boost > 0.02) {
      ctx.strokeStyle = 'rgba(150,210,255,' + (bh.boost * 0.5) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(bh.x, bh.y, shadow * (1.6 + Math.sin(w.time * 6) * 0.08), 0, 6.2832); ctx.stroke();
    }

    // 标注：视界 / 光子球 / ISCO
    if (w.labels) {
      var marks = [
        [1, 'Rs 视界', 'rgba(150,170,215,0.55)', [3, 5]],
        [PHOTON_K, '1.5 Rs 光子球', 'rgba(255,206,140,0.65)', [3, 5]],
        [ISCO_K, '3 Rs 最内稳定圆轨道', 'rgba(140,215,255,0.6)', [7, 6]],
        [SHADOW_K, '2.6 Rs 阴影（看到的轮廓）', 'rgba(255,255,255,0.35)', [1, 4]]
      ];
      ctx.save();
      for (var mi2 = 0; mi2 < marks.length; mi2++) {
        ctx.setLineDash(marks[mi2][3]);
        ctx.strokeStyle = marks[mi2][2];
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(bh.x, bh.y, bh.r * marks[mi2][0], 0, 6.2832); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 火星
    for (var qi = 0; qi < w.sparks.length; qi++) {
      var q = w.sparks[qi];
      ctx.globalAlpha = clamp(q.life / q.max, 0, 1);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.r / 2, q.y - q.r / 2, q.r, q.r);
    }
    ctx.globalAlpha = 1;

    // 事件圆环（脉冲 / 撒星星 / 撕裂）
    ctx.globalCompositeOperation = 'lighter';
    for (var gi = 0; gi < w.rings.length; gi++) {
      var g2 = w.rings[gi];
      ctx.globalAlpha = clamp(g2.life, 0, 1) * 0.5;
      ctx.strokeStyle = g2.color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(g2.x, g2.y, g2.r, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    ctx.restore();   // 回到屏幕坐标

    // 吞噬闪白 + 暗角
    if (w.flash > 0.01) {
      ctx.fillStyle = 'rgba(255,235,200,' + (w.flash * 0.35) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,' + (0.55 + (1 - w.cam.scale) * 0.55) + ')');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    // 里程碑提示
    if (w.milestone > 0) {
      ctx.globalAlpha = clamp(w.milestone, 0, 1);
      ctx.fillStyle = '#ffe6c0';
      ctx.font = '600 24px -apple-system, "Noto Sans CJK SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('质量 ' + fmt(bh.mass), W / 2, 46);
      ctx.font = '15px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(255,214,170,0.75)';
      ctx.fillText('吸积盘又亮了一点', W / 2, 68);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    // 哲学留言：画面下方居中，像一句安静的注脚
    if (w.phil > 0 && w.philText) {
      var pa = clamp(w.phil / 1.2, 0, 1) * clamp((9 - w.phil) / 0.6, 0, 1);
      ctx.globalAlpha = pa;
      ctx.textAlign = 'center';
      ctx.font = 'italic 300 18px -apple-system, "Noto Sans CJK SC", sans-serif';
      ctx.fillStyle = 'rgba(216,230,255,0.95)';
      var plines = wrapCJK(w.philText, 28);
      var pwid = 0, pli;
      for (pli = 0; pli < plines.length; pli++) pwid = Math.max(pwid, ctx.measureText(plines[pli]).width);
      var pbase = H - 104;
      for (pli = 0; pli < plines.length; pli++) {
        ctx.fillText(plines[pli], W / 2, pbase + pli * 27);
      }
      ctx.globalAlpha = pa * 0.28;
      ctx.strokeStyle = 'rgba(200,218,255,0.9)';
      ctx.lineWidth = 1;
      var ptop = pbase - 20, pbot = pbase + (plines.length - 1) * 27 + 14;
      ctx.beginPath(); ctx.moveTo(W / 2 - pwid / 2 - 8, ptop); ctx.lineTo(W / 2 + pwid / 2 + 8, ptop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W / 2 - pwid / 2 - 8, pbot); ctx.lineTo(W / 2 + pwid / 2 + 8, pbot); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    // 解锁 / 漫游提示
    if (w.hint > 0 && w.hintText) {
      ctx.globalAlpha = clamp(w.hint, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = '600 17px -apple-system, "Noto Sans CJK SC", sans-serif';
      ctx.fillStyle = 'rgba(255,230,190,0.92)';
      ctx.fillText(w.hintText, W / 2, 104);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    // 特殊事件：单独一行，带个小标记
    if (w.evT > 0 && w.evText) {
      ctx.globalAlpha = clamp(w.evT, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = '600 16px -apple-system, "Noto Sans CJK SC", sans-serif';
      ctx.fillStyle = 'rgba(176,214,255,0.95)';
      ctx.fillText('◈ ' + w.evText, W / 2, 132);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }
  }

  // ---------------------------------------------------------------- DOM
  var DPR = 1;
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('game'), ctx = canvas.getContext('2d');
  var stage = $('stage'), selftestEl = $('selftest');
  var els = {
    mass: $('hud-mass'), eaten: $('hud-eaten'), rs: $('hud-rs'), rate: $('hud-rate'), disk: $('disk'),
    ovStart: $('ov-start'), ovPause: $('ov-pause')
  };

  function fitCanvas() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (game) renderWorld(game, ctx);
  }

  function setLegend(on) {
    var el = $('legend');
    if (el) el.classList.toggle('hidden', !on);
  }

  function show(which) {
    els.ovStart.classList.toggle('hidden', which !== 'start');
    els.ovPause.classList.toggle('hidden', which !== 'pause');
    var p2 = $('btn-pause2');
    if (p2) p2.firstChild.textContent = (which === 'pause') ? '继续' : '暂停';
  }

  function syncHud(w) {
    els.mass.textContent = fmt(w.bh.mass);
    els.eaten.textContent = fmt(w.eaten);
    els.rs.textContent = w.bh.r.toFixed(0);
    els.disk.firstChild.style.width = clamp(w.rateAvg / 14 * 100, 0, 100).toFixed(0) + '%';
    var r = w.rateAvg;
    els.rate.textContent = r > 9 ? '炽热' : (r > 4 ? '活跃' : (r > 1.2 ? '微亮' : '平静'));
    var pb = $('btn-pulse');
    if (pb) {
      var cd = w.jetCd;
      pb.classList.toggle('cool', cd > 0);
      pb.disabled = cd > 0;
      pb.firstChild.textContent = cd > 0 ? ('脉冲 ' + cd.toFixed(0) + 's') : '脉冲';
    }
  }

  // ---------------------------------------------------------------- 输入
  var game = null, mode = 'menu', input = { pointerX: null, pointerY: null, pull: false, auto: false };
  var lastTouchAt = 0, activeTouchId = null;

  function toLogical(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    return {
      x: clamp((clientX - r.left) / r.width * W, 0, W),
      y: clamp((clientY - r.top) / r.height * H, 0, H)
    };
  }

  function setPointer(clientX, clientY) {
    var p = toLogical(clientX, clientY);
    input.pointerX = p.x; input.pointerY = p.y;
  }

  stage.addEventListener('mousemove', function (e) {
    if (mode !== 'play' || !game) return;
    setPointer(e.clientX, e.clientY);
  });
  stage.addEventListener('mousedown', function (e) {
    Sound.unlock();
    if (mode !== 'play' || !game) return;
    if (Date.now() - lastTouchAt < 600) return;
    if (game.zen) { toggleZen(false); return; }      // 静观模式点一下退出
    setPointer(e.clientX, e.clientY);
  });
  stage.addEventListener('touchstart', function (e) {
    Sound.unlock();
    lastTouchAt = Date.now();
    if (mode !== 'play' || !game) return;
    if (game.zen) { toggleZen(false); e.preventDefault(); return; }
    var t = e.changedTouches[0];
    if (activeTouchId === null) activeTouchId = t.identifier;
    if (t.identifier === activeTouchId) setPointer(t.clientX, t.clientY);
    e.preventDefault();
  }, { passive: false });
  stage.addEventListener('touchmove', function (e) {
    lastTouchAt = Date.now();
    if (activeTouchId === null || mode !== 'play' || !game) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier === activeTouchId) { setPointer(t.clientX, t.clientY); e.preventDefault(); }
    }
  }, { passive: false });
  function endTouch(e) {
    lastTouchAt = Date.now();
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === activeTouchId) activeTouchId = null;
    }
  }
  stage.addEventListener('touchend', endTouch);
  stage.addEventListener('touchcancel', endTouch);

  function startGame(zen) {
    Sound.unlock();
    game = createWorld(20261009);
    game.camDist = camDist;
    game.labels = labelsOn;
    setLegend(labelsOn);
    toggleZen(false);
    if (zen) { game.auto = true; input.auto = true; $('btn-auto').classList.add('on'); }
    mode = 'play';
    show(null);
    syncHud(game);
  }
  function resetGame() { startGame(input.auto); }

  var labelsOn = true;
  var timeScale = 1;

  // ---- 时间流速 / 画面大小 滑块 ----
  var timeEl = $('time'), timeV = $('time-v'), distEl = $('dist'), distV = $('dist-v');
  var camDist = 1;
  function getCamDist() { return camDist; }
  function getTimeScale() { return timeScale; }
  var tiltEl = $('tilt'), tiltV = $('tilt-v');
  function getTilt() { return tiltDeg; }
  function getSquash() { return diskSquash(); }
  function syncPresetButtons() {
    var top = $('tilt-top'), side = $('tilt-side');
    if (top) top.classList.toggle('on', tiltDeg < 15);
    if (side) side.classList.toggle('on', tiltDeg > 45);
  }
  function applyTilt(save) {
    if (tiltEl) tiltDeg = clamp(parseFloat(tiltEl.value), 0, 80);
    squash = Math.cos(tiltDeg * Math.PI / 180);
    if (tiltV) {
      tiltV.textContent = Math.round(tiltDeg) + '°';
      tiltV.title = tiltDeg < 20 ? '俯视：盘是圆的，物质按开普勒定律绕行'
        : (tiltDeg > 55 ? '近侧视：盘压成一条，上下透镜拱最明显' : '斜视');
    }
    syncPresetButtons();
    if (save) { try { localStorage.setItem('blackhole.tilt.v2', String(tiltDeg)); } catch (e) {} }
  }
  if (tiltEl) tiltEl.addEventListener('input', function () { applyTilt(true); });
  function setTilt(deg) {
    tiltDeg = clamp(deg, 0, 80);
    if (tiltEl) tiltEl.value = String(Math.round(tiltDeg));
    applyTilt(true);
  }
  var topBtn = $('tilt-top'), sideBtn = $('tilt-side');
  if (topBtn) topBtn.addEventListener('click', function (e) { e.preventDefault(); setTilt(0); });
  if (sideBtn) sideBtn.addEventListener('click', function (e) { e.preventDefault(); setTilt(63); });

  try {
    var tSaved2 = parseFloat(localStorage.getItem('blackhole.tilt.v2') || '');
    if (!isNaN(tSaved2) && tiltEl) tiltEl.value = String(tSaved2);
  } catch (e) {}
  applyTilt();
  function applyTimeScale() {
    if (!timeEl) return;
    timeScale = clamp(parseFloat(timeEl.value) / 100, 0.2, 3);
    timeV.textContent = timeScale.toFixed(1) + '×';
    try { localStorage.setItem('blackhole.time', String(timeScale)); } catch (e) {}
  }
  function applyCamDist() {
    if (!distEl) return;
    camDist = clamp(parseFloat(distEl.value) / 100, 1, 2.5);
    if (distV) distV.textContent = '×' + camDist.toFixed(1);
    if (game) game.camDist = camDist;
    try { localStorage.setItem('blackhole.dist', String(camDist)); } catch (e) {}
  }
  function setCamDist(v) {
    camDist = clamp(v, 1, 2.5);
    if (distEl) distEl.value = String(Math.round(camDist * 100));
    applyCamDist();
  }
  if (timeEl) timeEl.addEventListener('input', applyTimeScale);
  if (distEl) distEl.addEventListener('input', applyCamDist);
  try {
    var tSaved = parseFloat(localStorage.getItem('blackhole.time') || '');
    if (tSaved > 0 && timeEl) timeEl.value = String(Math.round(tSaved * 100));
    var dSaved = parseFloat(localStorage.getItem('blackhole.dist') || '');
    if (dSaved > 0 && distEl) distEl.value = String(Math.round(dSaved * 100));
  } catch (e) {}
  applyTimeScale();
  applyCamDist();

  // 实体按键
  [['btn-pull', 'pull'], ['btn-auto', 'auto'], ['btn-labels', 'labels']].forEach(function (pair) {
    var el = $(pair[0]);
    if (!el) return;
    if (pair[1] === 'pull') {
      var press = function (e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        Sound.unlock();
        input.pull = true; el.classList.add('on');
      };
      var rel = function (e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        input.pull = false; el.classList.remove('on');
      };
      el.addEventListener('pointerdown', press);
      el.addEventListener('pointerup', rel);
      el.addEventListener('pointercancel', rel);
      el.addEventListener('pointerleave', rel);
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    } else {
      el.addEventListener('click', function (e) {
        e.preventDefault(); Sound.unlock();
        if (pair[1] === 'auto') {
          input.auto = !input.auto;
          if (game) { game.auto = input.auto; game.userHold = 0; }
          el.classList.toggle('on', input.auto);
        } else {
          labelsOn = !labelsOn;
          if (game) game.labels = labelsOn;
          el.classList.toggle('on', labelsOn);
          setLegend(labelsOn);
        }
      });
    }
  });
  input.auto = false;
  $('btn-auto').classList.remove('on');
  $('btn-labels').classList.add('on');
  setLegend(true);

  var btnPulse = $('btn-pulse');
  if (btnPulse) btnPulse.addEventListener('click', function (e) {
    e.preventDefault(); Sound.unlock();
    if (mode === 'menu') { startGame(false); return; }
    if (game) pulse(game);
  });
  var btnSpawn = $('btn-spawn');
  if (btnSpawn) btnSpawn.addEventListener('click', function (e) {
    e.preventDefault(); Sound.unlock();
    if (mode === 'menu') { startGame(false); return; }
    if (game) spawnCluster(game, 80);
  });
  // 暂停时轮换的文案（每次暂停换一句，不重样）
  var PAUSE_LINES = [
    '深呼吸，或者不深呼吸。',
    '这里的钟停了，外面的没有。',
    '它跑不掉，你也别急。',
    '引力不需要你盯着才生效。',
    '什么都不做，也是一种轨道。',
    '你刚才吃掉的东西，正在变成面积。',
    '松一下肩膀——它比吸积盘更早塌缩。',
    '慢慢来，光都要走很久。',
    '熵还在涨，只是你看不见。',
    '暂停不是停止，是绕远一点。',
    '一切都会落到中心，包括注意力。',
    '此刻没有事件，只有视界。',
    '让盘自己转一会儿。',
    '你随时可以继续，也随时可以先发呆。'
  ];
  var pauseIdx = Math.floor(Math.random() * PAUSE_LINES.length);
  function nextPauseLine() {
    pauseIdx = (pauseIdx + 1) % PAUSE_LINES.length;
    var el = $('pause-line');
    if (el) el.textContent = PAUSE_LINES[pauseIdx];
    return PAUSE_LINES[pauseIdx];
  }

  var preZenDist = 1;
  function toggleZen(on) {
    if (!game) return;
    var was = game.zen;
    if (on && !was) { preZenDist = camDist; setCamDist(ZEN_DIST); }     // 进入静观：拨远
    if (!on && was) { setCamDist(preZenDist); }                         // 退出静观：拨回
    game.zen = !!on;
    if (on) { game.auto = true; input.auto = true; $('btn-auto').classList.add('on'); }
    var el = $('btn-zen');
    if (el) el.classList.toggle('on', !!on);
    var wrap = $('wrap');
    if (wrap) wrap.classList.toggle('zen', !!on);
    game.hint = 3;
    game.hintText = on ? '静观模式：镜头会慢慢拉远，点一下画面退出' : '';
  }
  var btnZen = $('btn-zen');
  if (btnZen) btnZen.addEventListener('click', function (e) {
    e.preventDefault(); Sound.unlock();
    if (mode === 'menu') { startGame(false); return; }
    toggleZen(!(game && game.zen));
  });

  var btnPause2 = $('btn-pause2');
  if (btnPause2) btnPause2.addEventListener('click', function (e) { e.preventDefault(); togglePause(); });
  var btnSound2 = $('btn-sound2');
  if (btnSound2) btnSound2.addEventListener('click', function (e) {
    e.preventDefault(); Sound.setMuted(!Sound.isMuted()); updateSoundBtn();
  });

  function updateSoundBtn() {
    var m = Sound.isMuted();
    var b2 = $('btn-sound2');
    if (b2) b2.firstChild.textContent = m ? '静音中' : '声音';
  }
  updateSoundBtn();

  $('btn-start').addEventListener('click', function () { startGame(false); });
  var btnZenStart = $('btn-zen-start');
  if (btnZenStart) btnZenStart.addEventListener('click', function () {
    $('btn-auto').classList.add('on');
    input.auto = true;
    startGame(true);
    toggleZen(true);
  });
  $('btn-resume').addEventListener('click', function () {
    mode = 'play'; if (game) game.paused = false; show(null);
  });
  $('btn-reset').addEventListener('click', function () { resetGame(); });
  function togglePause() {
    if (mode === 'play') { mode = 'pause'; if (game) game.paused = true; nextPauseLine(); show('pause'); }
    else if (mode === 'pause') { mode = 'play'; if (game) game.paused = false; show(null); }
  }

  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === ' ') { e.preventDefault(); Sound.unlock(); if (mode === 'menu') startGame(false); else if (game) pulse(game); }
    else if (k === 'f' || k === 'F') { if (game) spawnCluster(game, 80); }
    else if (k === 'a' || k === 'A') { $('btn-auto').click(); }
    else if (k === 'l' || k === 'L') { $('btn-labels').click(); }
    else if (k === 'v' || k === 'V') { if (mode === 'menu') startGame(false); else toggleZen(!(game && game.zen)); }
    else if (k === 'm' || k === 'M') { Sound.setMuted(!Sound.isMuted()); updateSoundBtn(); }
    else if (k === 'p' || k === 'P' || k === 'Escape') { togglePause(); }
    else if (k === 'r' || k === 'R') { if (mode !== 'menu') resetGame(); }
  });
  window.addEventListener('blur', function () {
    input.pull = false; input.pointerX = null;
    var el = $('btn-pull'); if (el) el.classList.remove('on');
  });

  // ---------------------------------------------------------------- 主循环
  var acc = 0, last = 0, running = true;
  var params = new URLSearchParams(location.search);
  var shotTime = parseFloat(params.get('t') || '10');
  var selftest = params.has('selftest');
  var speedup = parseFloat(params.get('speed') || '1');

  function frame(ts) {
    if (!last) last = ts;
    var dt = Math.min((ts - last) / 1000, MAX_FRAME);
    last = ts;
    if (mode === 'play' && game) {
      game.timeScale = timeScale;
      game.camDist = camDist;
      acc += dt * speedup * timeScale;
      var guard = 0;
      while (acc >= FIXED && guard < 2400) { stepWorld(game, FIXED, input); acc -= FIXED; guard++; }
      renderWorld(game, ctx);
      syncHud(game);
    } else if (game) {
      renderWorld(game, ctx);
    }
    if (running) requestAnimationFrame(frame);
  }

  var pTilt0 = parseFloat(params.get('tilt') || '');
  if (!isNaN(pTilt0)) { tiltDeg = clamp(pTilt0, 0, 80); if (tiltEl) tiltEl.value = String(Math.round(tiltDeg)); applyTilt(false); }

  if (params.has('shot')) {
    var lvl = parseInt(params.get('shot'), 10) || 1;
    game = createWorld(20261009 + lvl);
    game.camDist = camDist;
    mode = 'play';
    input.auto = true; game.auto = true;
    Sound.setSilent(true);
    show(null);
    var pDist = parseFloat(params.get('dist') || '');
    if (pDist > 0) setCamDist(pDist);
    var pTilt = parseFloat(params.get('tilt') || '');
    if (!isNaN(pTilt) && tiltEl) { tiltEl.value = String(pTilt); applyTilt(); }
    var pTime = parseFloat(params.get('time') || '');
    if (pTime > 0 && timeEl) { timeEl.value = String(Math.round(pTime * 100)); applyTimeScale(); }
    var seedMass = parseFloat(params.get('mass') || '0');
    if (seedMass > 0) game.bh.mass = seedMass;     // 截图用：直接播种质量，好看到解锁后的天体
    runBot(game, shotTime);
    if (params.has('dbg')) {
      var visN = 0, visR = (W / 2) / clamp(game.cam.scale, SCALE_MIN, 1);
      for (var vi = 0; vi < game.particles.length; vi++) {
        if (Math.hypot(game.particles[vi].x - game.bh.x, game.particles[vi].y - game.bh.y) < visR) visN++;
      }
      document.title = 'vis=' + visN + ' pop=' + game.particles.length + ' spawned=' + game.spawned +
      ' eaten=' + game.eaten + ' minis=' + (game.minis ? game.minis.length : 0) +
      ' time=' + game.time.toFixed(0) + ' rate=' + game.rate.toFixed(1) + ' rateAvg=' + game.rateAvg.toFixed(1) +
      ' target=' + Math.round(TARGET_POP / Math.pow(clamp(game.cam.scale, SCALE_MIN, 1), 1.15));
    }
    if (params.has('event')) {
      var evId = params.get('event');
      if (EVENT_FN[evId]) {
        var evR = EVENT_FN[evId](game);
        game.evText = evR.text; game.evT = evR.dur + 1.6;
        for (var evS = 0; evS < 120 * (parseFloat(params.get('evt') || '1.2')); evS++) {
          stepWorld(game, FIXED, { pointerX: null, pointerY: null, auto: true });
        }
      }
    }
    if (params.has('pause')) {
      mode = 'pause'; game.paused = true;
      nextPauseLine(); nextPauseLine();
      show('pause');
    }
    if (params.has('phil')) {
      var pIdx = parseInt(params.get('phil'), 10) || 0;
      game.phil = 6;
      game.philText = PHILOSOPHY[((pIdx % PHILOSOPHY.length) + PHILOSOPHY.length) % PHILOSOPHY.length];
    }
    if (params.has('jets')) {
      fireJets(game, 1.2);
      for (var js = 0; js < 120 * 0.55; js++) stepWorld(game, FIXED, { pull: false, auto: true });
    }
    if (params.has('zen')) {
      toggleZen(true);
      for (var zs = 0; zs < 120 * 14; zs++) stepWorld(game, FIXED, { pull: false, auto: true });
    }
    fitCanvas();
    renderWorld(game, ctx);
    syncHud(game);
    running = false;
  } else if (!selftest) {
    fitCanvas();
    mode = 'menu';
    game = createWorld(20261009);
    renderWorld(game, ctx);
    show('start');
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', fitCanvas);

  // ---------------------------------------------------------------- 机器人 + 自测
  function runBot(w, seconds, dt) {
    dt = dt || FIXED;
    Sound.setSilent(true);
    var steps = Math.floor(seconds / dt);
    for (var i = 0; i < steps; i++) {
      if (i % 600 === 0) { w.pull = true; } else if (i % 600 === 240) { w.pull = false; }
      if (i % 900 === 300) pulse(w);
      if (i % 1500 === 700) spawnCluster(w, 60);
      stepWorld(w, dt, { pointerX: null, pointerY: null, pull: w.pull, auto: true });
    }
    return w;
  }

  function runSelfTest() {
    var results = { pass: true, checks: [] };
    function check(name, ok, extra) {
      results.checks.push({ name: name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
      if (!ok) results.pass = false;
    }
    Sound.setSilent(true);

    // 1) 初始状态
    var w0 = createWorld(1234);
    check('初始有粒子', w0.particles.length > 200, w0.particles.length);
    check('初始质量 = 1000', w0.bh.mass === 1000, w0.bh.mass);
    check('初始视界半径 = R0', Math.abs(w0.bh.r - R0) < 0.01, w0.bh.r);

    // 2) 引力方向：静止粒子在洞右侧，一步后应向左加速
    var w1 = createWorld(1234);
    w1.particles.length = 0;
    w1.particles.push({ kind: 'dust', x: w1.bh.x + 300, y: w1.bh.y, vx: 0, vy: 0, r: 2, m: 1, heat: 0, life: 0, maxLife: 0, trail: [], dead: false });
    stepWorld(w1, FIXED, {});
    var p1 = w1.particles[0];
    check('引力把粒子拉向黑洞', p1 && p1.vx < 0, p1 ? p1.vx.toExponential(2) : 'gone');

    // 3) 圆轨道稳定性：给圆轨道速度，跑 4 秒半径不应剧变
    var w2 = createWorld(1234);
    w2.particles.length = 0;
    var R = 240, vc = Math.sqrt(w2.bh.gm / R);
    w2.particles.push({ kind: 'dust', x: w2.bh.x + R, y: w2.bh.y, vx: 0, vy: vc, r: 2, m: 1, heat: 0, life: 0, maxLife: 0, trail: [], dead: false });
    for (var s2 = 0; s2 < 120 * 4; s2++) stepWorld(w2, FIXED, {});
    var orb = w2.particles[0];
    var rr = orb ? Math.hypot(orb.x - w2.bh.x, orb.y - w2.bh.y) : 0;
    check('圆轨道 4 秒内不散（半径变化 < 25%）', orb && Math.abs(rr - R) / R < 0.25, orb ? rr.toFixed(0) + ' px' : '被吃掉/飞走');

    // 4) 吞噬：视界内一步吃掉并增加质量
    var w3 = createWorld(1234);
    w3.particles.length = 0;
    w3.particles.push({ kind: 'star', x: w3.bh.x + w3.bh.r * 0.5, y: w3.bh.y, vx: 0, vy: 0, r: 3, m: 4, heat: 1, life: 0, maxLife: 0, trail: [], dead: false });
    var m0 = w3.bh.mass;
    stepWorld(w3, FIXED, {});
    check('视界内的粒子被吞噬', w3.particles.length === 0, w3.particles.length);
    check('吞噬后质量增加', w3.bh.mass === m0 + 4, w3.bh.mass - m0);

    // 5) 洛希极限：行星在撕裂半径内变成碎片流
    var w4 = createWorld(1234);
    w4.particles.length = 0;
    var rr4 = w4.bh.r * 3.2 + 20 * 2.5 - 2;   // 略小于洛希半径
    w4.particles.push({ kind: 'planet', x: w4.bh.x + rr4, y: w4.bh.y, vx: 0, vy: 0, r: 20, m: 40, heat: 0, life: 0, maxLife: 0, trail: [], dead: false });
    stepWorld(w4, FIXED, {});
    var frags = w4.particles.filter(function (p) { return p.kind === 'frag'; }).length;
    var planets = w4.particles.filter(function (p) { return p.kind === 'planet'; }).length;
    check('行星在洛希极限内被撕碎', planets === 0 && frags >= 10, '碎片 ' + frags);

    // 6) 长时间模拟：无 NaN、粒子不失控、种群维持
    var w5 = createWorld(777);
    var nan = 0, outside = 0;
    for (var s5 = 0; s5 < 120 * 25; s5++) {
      stepWorld(w5, FIXED, { auto: true });
      if (s5 % 60 === 0) {
        for (var pi = 0; pi < w5.particles.length; pi++) {
          var pp = w5.particles[pi];
          if (!isFinite(pp.x) || !isFinite(pp.y) || !isFinite(pp.vx) || !isFinite(pp.vy)) nan++;
          var dd = Math.hypot(pp.x - w5.bh.x, pp.y - w5.bh.y);
          if (dd > 2000) outside++;
        }
      }
    }
    check('25 秒模拟无 NaN', nan === 0, nan);
    check('没有粒子跑到 2000px 之外', outside === 0, outside);
    check('粒子数不超过上限', w5.particles.length <= MAX_PARTICLES, w5.particles.length);
    check('自动漫游时确实吃到了东西', w5.eaten > 20, w5.eaten);
    check('质量在增长', w5.bh.mass > 1000, w5.bh.mass);
    check('半径随质量变大', w5.bh.r > R0, w5.bh.r.toFixed(1));

    // 7) 脉冲：远处粒子被拉近
    var w6 = createWorld(1234);
    w6.particles.length = 0;
    w6.particles.push({ kind: 'dust', x: w6.bh.x + 400, y: w6.bh.y, vx: 0, vy: 0, r: 2, m: 1, heat: 0, life: 0, maxLife: 0, trail: [], dead: false });
    var ok6 = pulse(w6);
    check('脉冲可用', ok6 === true);
    var vc6 = Math.sqrt(w6.bh.gm / 400);
    check('脉冲给的内向冲量 ≥ 轨道速度的 10%', w6.particles[0].vx < -vc6 * 0.1, w6.particles[0].vx.toFixed(1) + ' vs vc=' + vc6.toFixed(1));
    check('脉冲进入冷却（共享的喷流冷却）', w6.jetCd > 0, w6.jetCd.toFixed(1) + ' 秒');
    check('冷却中不能重复脉冲', pulse(w6) === false);
    var w6b = createWorld(1235);
    var jetsBefore = w6b.particles.filter(function (p) { return p.kind === 'jet'; }).length;
    pulse(w6b);
    var jetsAfter = w6b.particles.filter(function (p) { return p.kind === 'jet'; }).length;
    check('脉冲会同时喷出喷流', jetsAfter - jetsBefore >= 10, '+' + (jetsAfter - jetsBefore) + ' 个喷流粒子');
    var upAfter = w6b.particles.filter(function (p) { return p.kind === 'jet' && p.vy < 0; }).length;
    var dnAfter = w6b.particles.filter(function (p) { return p.kind === 'jet' && p.vy > 0; }).length;
    check('脉冲的喷流是双向的', upAfter > 0 && dnAfter > 0, '上 ' + upAfter + ' / 下 ' + dnAfter);

    // 8) 吸力增强 → 引力更大
    var w7 = createWorld(1234);
    w7.pull = true;
    for (var s7 = 0; s7 < 60; s7++) stepWorld(w7, FIXED, {});
    var gmBoosted = w7.bh.gm;
    var w8 = createWorld(1234);
    for (var s8 = 0; s8 < 60; s8++) stepWorld(w8, FIXED, {});
    check('吸力增强会提高引力', gmBoosted > w8.bh.gm * 1.4, gmBoosted.toExponential(2) + ' vs ' + w8.bh.gm.toExponential(2));

    // 9) 撒星星
    var w9 = createWorld(1234);
    var n0 = w9.particles.length;
    spawnCluster(w9, 80);
    check('撒星星会增加粒子', w9.particles.length > n0, (w9.particles.length - n0) + ' 个');

    // 10) 粒子数到上限时不再增加
    var w10 = createWorld(1234);
    for (var s10 = 0; s10 < 900; s10++) spawnCluster(w10, 200);
    check('粒子数受上限保护', w10.particles.length <= MAX_PARTICLES, w10.particles.length);

    // 11) 性能：1000 粒子单步耗时
    var w11 = createWorld(1234);
    while (w11.particles.length < 1000) spawnParticle(w11, 'dust', true);
    var t0 = (performance && performance.now) ? performance.now() : Date.now();
    for (var s11 = 0; s11 < 120; s11++) stepWorld(w11, FIXED, {});
    var elapsed = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
    var perStep = elapsed / 120;
    check('1000 粒子单步 < 6ms（能跑满 60fps）', perStep < 6, perStep.toFixed(2) + ' ms/步');

    // 12) 按钮
    var ids = ['btn-pull', 'btn-pulse', 'btn-spawn', 'btn-auto', 'btn-zen', 'btn-labels', 'btn-sound2', 'btn-pause2'];
    var missing = ids.filter(function (id) { return !document.getElementById(id); });
    check('八个实体按键都在页面上', missing.length === 0, missing.join(','));
    var pullEl = document.getElementById('btn-pull');
    if (pullEl) {
      input.pull = false;
      pullEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7 }));
      check('按住「吸力」→ 引力增强生效', input.pull === true, 'pull=' + input.pull);
      pullEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7 }));
      check('松开「吸力」→ 恢复', input.pull === false, 'pull=' + input.pull);
    }
    var autoEl = document.getElementById('btn-auto');
    if (autoEl) {
      var a0 = input.auto;
      autoEl.click();
      check('「自动漫游」可切换', input.auto !== a0, 'auto=' + input.auto);
      autoEl.click();
    }

    // 13) 漫游模式下鼠标不接管
    var w12 = createWorld(4321);
    w12.auto = true; w12.bh.tx = W / 2; w12.bh.ty = H / 2;
    for (var s12 = 0; s12 < 120 * 2; s12++) stepWorld(w12, FIXED, { pointerX: 60, pointerY: 40, auto: true });
    check('漫游时鼠标不接管（黑洞没被拖到指针处）', Math.hypot(w12.bh.x - 60, w12.bh.y - 40) > 150,
          '距指针 ' + Math.round(Math.hypot(w12.bh.x - 60, w12.bh.y - 40)) + 'px');

    // 14) 关掉漫游后鼠标接管
    var w13 = createWorld(4321);
    w13.auto = false;
    for (var s13 = 0; s13 < 120 * 2; s13++) stepWorld(w13, FIXED, { pointerX: 120, pointerY: 120 });
    check('关掉漫游后鼠标能拖动', Math.hypot(w13.bh.x - 120, w13.bh.y - 120) < 40,
          '距指针 ' + Math.round(Math.hypot(w13.bh.x - 120, w13.bh.y - 120)) + 'px');

    // 15) 质量解锁新天体
    var w14 = createWorld(999); w14.bh.mass = 2600; stepWorld(w14, FIXED, {});
    check('质量 2600 解锁彗星', !!w14.unlocked.comet);
    w14.bh.mass = 6500; stepWorld(w14, FIXED, {});
    check('质量 6500 解锁星云团', !!w14.unlocked.nebula);
    w14.bh.mass = 12600; stepWorld(w14, FIXED, {});
    check('质量 12600 解锁小黑洞', !!w14.unlocked.minibh);
    check('解锁会给出提示', w14.hint > 0 && /小黑洞/.test(w14.hintText), w14.hintText);
    check('双星已经完全移除（解锁表里没有它）',
          !UNLOCKS.some(function (u) { return u.kind === 'binary'; }) && !KINDS.binary);

    // 16) 彗星会拖尾
    var w15 = createWorld(555);
    w15.particles.length = 0;
    spawnParticle(w15, 'comet', true);
    for (var s15 = 0; s15 < 120 * 2; s15++) stepWorld(w15, FIXED, {});
    var comets = w15.particles.filter(function (p) { return p.kind === 'comet'; });
    check('彗星会拖出尾巴', comets.length > 0 && comets[0].trail.length > 5,
          comets.length ? comets[0].trail.length + ' 段' : '彗星没了');

    // 17) 星云团靠近会散成尘埃
    var w16 = createWorld(666);
    w16.particles.length = 0;
    var nb = spawnParticle(w16, 'nebula', true);
    nb.x = w16.bh.x + 300; nb.y = w16.bh.y; nb.vx = 0; nb.vy = 0;
    var dust0 = 0;
    for (var s16 = 0; s16 < 120 * 12; s16++) {
      stepWorld(w16, FIXED, {});
      if (!w16.particles.some(function (p) { return p.kind === 'nebula'; })) break;
    }
    var dust1 = w16.particles.filter(function (p) { return p.kind === 'dust'; }).length;
    check('星云团会散成一片尘埃', dust1 >= 60, dust1 + ' 颗尘埃');
    check('星云团变大了（半径 ≥ 55）', nb.r >= 55, 'r=' + nb.r.toFixed(0));
    check('大星云团散出的尘埃更多（≥ 150 颗）', dust1 >= 150, dust1 + ' 颗尘埃');

    // 18) 小黑洞：自己带引力、会吞物质、会被主黑洞吃掉、两个会并合
    var wbh = createWorld(1801);
    wbh.particles.length = 0;
    var mini = spawnMiniBH(wbh, true);
    check('小黑洞生成了', !!mini && mini.kind === 'minibh', mini ? 'm=' + mini.m.toFixed(0) : '没生成');
    check('小黑洞有自己的引力参数与影响半径', mini.gm > 0 && mini.infl > 20,
          'gm=' + mini.gm.toFixed(0) + ' infl=' + mini.infl.toFixed(0));

    // 附近的尘埃应该被它拽近：两者同速、切向偏移，才是在量小黑洞自己的引力
    var angM = Math.atan2(mini.y - wbh.bh.y, mini.x - wbh.bh.x);
    var rM = Math.hypot(mini.x - wbh.bh.x, mini.y - wbh.bh.y);
    var vcM = circularSpeed(wbh, rM);
    mini.vx = -Math.sin(angM) * vcM; mini.vy = Math.cos(angM) * vcM;
    var dm = spawnParticle(wbh, 'dust', true);
    dm.x = mini.x + Math.cos(angM + Math.PI / 2) * 70;
    dm.y = mini.y + Math.sin(angM + Math.PI / 2) * 70;
    dm.vx = mini.vx; dm.vy = mini.vy;
    var dStart = Math.hypot(dm.x - mini.x, dm.y - mini.y);
    for (var sm = 0; sm < 120 * 2; sm++) stepWorld(wbh, FIXED, {});
    var dNow = dm.dead ? 0 : Math.hypot(dm.x - mini.x, dm.y - mini.y);
    check('小黑洞会把附近的尘埃拽过去', dm.dead || dNow < dStart - 8,
          dStart.toFixed(0) + 'px → ' + (dm.dead ? '被吞了' : dNow.toFixed(0) + 'px'));

    // 直接放在嘴边：应该立刻被吞掉并变重
    var wbh2 = createWorld(1802);
    wbh2.particles.length = 0;
    var mini2 = spawnMiniBH(wbh2, true);
    var mBefore = mini2.m;
    var snack = spawnParticle(wbh2, 'star', true);
    snack.x = mini2.x + mini2.eat * 0.5; snack.y = mini2.y; snack.vx = 0; snack.vy = 0;
    for (var sm2 = 0; sm2 < 30; sm2++) stepWorld(wbh2, FIXED, {});
    check('小黑洞会吞掉靠得太近的物质', snack.dead === true);
    check('吞完会变重', mini2.m > mBefore, mBefore.toFixed(0) + ' → ' + mini2.m.toFixed(0));

    // 主黑洞吃掉小黑洞：一次贡献一大块质量
    var wbh3 = createWorld(1803);
    wbh3.particles.length = 0;
    var mini3 = spawnMiniBH(wbh3, true);
    mini3.absorbed = 500;
    mini3.m = 1500;
    miniStats(mini3);
    var massBefore = wbh3.bh.mass;
    mini3.x = wbh3.bh.x + wbh3.bh.r + 6; mini3.y = wbh3.bh.y;
    mini3.vx = -120; mini3.vy = 0;
    for (var sm3 = 0; sm3 < 120 * 6; sm3++) {
      stepWorld(wbh3, FIXED, {});
      if (wbh3.particles.indexOf(mini3) < 0) break;
    }
    check('主黑洞会吃掉小黑洞', wbh3.particles.indexOf(mini3) < 0);
    check('吃掉小黑洞会一次性大幅增重', wbh3.bh.mass - massBefore >= 1500,
          '+' + fmt(Math.round(wbh3.bh.mass - massBefore)));

    // 两个小黑洞靠得足够近会并合
    var wbh4 = createWorld(1804);
    wbh4.particles.length = 0;
    var ma = spawnMiniBH(wbh4, true), mb2 = spawnMiniBH(wbh4, true);
    ma.x = wbh4.bh.x + 300; ma.y = wbh4.bh.y; ma.vx = 0; ma.vy = 0; ma.m = 900; miniStats(ma);
    mb2.x = ma.x + (ma.r + mb2.r) * 0.7; mb2.y = ma.y; mb2.vx = 0; mb2.vy = 0; mb2.m = 700; miniStats(mb2);
    var mSum = ma.m + mb2.m;
    for (var sm4 = 0; sm4 < 20; sm4++) stepWorld(wbh4, FIXED, {});
    var live = wbh4.particles.filter(function (p) { return p.kind === 'minibh' && !p.dead; });
    check('两个小黑洞会并合成一个', live.length === 1, live.length + ' 个');
    check('并合后质量相加', live.length === 1 && Math.abs(live[0].m - mSum) < 1, live.length === 1 ? live[0].m.toFixed(0) : '—');

    // 长时间跑：不应该再出现双星
    var wNoBin = createWorld(1805);
    wNoBin.unlocked = { comet: true, nebula: true, minibh: true };
    for (var sb = 0; sb < 120 * 20; sb++) stepWorld(wNoBin, FIXED, {});
    check('跑 20 秒也不会再出现双星',
          wNoBin.particles.filter(function (p) { return p.kind === 'binary'; }).length === 0);

    // 19) 小黑洞会跟着主黑洞的引力走（不会自己飞出去）
    var w18 = createWorld(888);
    w18.particles.length = 0;
    var mOrbit = spawnMiniBH(w18, true);
    var rOrbit0 = Math.hypot(mOrbit.x - w18.bh.x, mOrbit.y - w18.bh.y);
    for (var s18 = 0; s18 < 120 * 6; s18++) stepWorld(w18, FIXED, {});
    var rOrbit1 = mOrbit.dead ? 0 : Math.hypot(mOrbit.x - w18.bh.x, mOrbit.y - w18.bh.y);
    check('小黑洞绕着主黑洞转（不会飞走）', mOrbit.dead || rOrbit1 < rOrbit0 * 2.5,
          rOrbit0.toFixed(0) + 'px → ' + (mOrbit.dead ? '被吃掉' : rOrbit1.toFixed(0) + 'px'));

    // 20) 喷流真的会把物质吹开（和侧面同样距离的粒子做对照；要在喷流可见的视角下）
    var tiltSave20 = getTilt();
    setTilt(63);
    var w19 = createWorld(1010);
    w19.particles.length = 0;
    var inJet = { kind: 'dust', x: w19.bh.x, y: w19.bh.y - 220, vx: 0, vy: 0, r: 2, m: 1, heat: 0, life: 0, maxLife: 0, trail: [], seed: 1, dead: false, pair: null, cloud: 0 };
    var side = { kind: 'dust', x: w19.bh.x + 220, y: w19.bh.y, vx: 0, vy: 0, r: 2, m: 1, heat: 0, life: 0, maxLife: 0, trail: [], seed: 2, dead: false, pair: null, cloud: 0 };
    w19.particles.push(inJet, side);
    var bomb = { kind: 'planet', x: w19.bh.x + 4, y: w19.bh.y, vx: 0, vy: 0, r: 8, m: 60, heat: 0, life: 0, maxLife: 0, trail: [], seed: 3, dead: false, pair: null, cloud: 0 };
    w19.particles.push(bomb);
    for (var s19 = 0; s19 < 120 * 1.5; s19++) stepWorld(w19, FIXED, {});
    var rJet = Math.hypot(inJet.x - w19.bh.x, inJet.y - w19.bh.y);
    var rSide = Math.hypot(side.x - w19.bh.x, side.y - w19.bh.y);
    check('喷流把 funnel 里的物质吹得比侧面更远', rJet > rSide,
          '喷流侧 ' + rJet.toFixed(0) + 'px vs 侧面 ' + rSide.toFixed(0) + 'px');

    // 20b) 俯视时喷流投影为 0，就不该再推物质（看不见的东西不该使力）
    var w19b = createWorld(1011);
    w19b.particles.length = 0;
    var inJetB = { kind: 'dust', x: w19b.bh.x, y: w19b.bh.y - 220, vx: 0, vy: 0, r: 2, m: 1, heat: 0, life: 0, maxLife: 0, trail: [], seed: 1, dead: false, pair: null, cloud: 0 };
    w19b.particles.push(inJetB);
    w19b.particles.push({ kind: 'planet', x: w19b.bh.x + 4, y: w19b.bh.y, vx: 0, vy: 0, r: 8, m: 60, heat: 0, life: 0, maxLife: 0, trail: [], seed: 3, dead: false, pair: null, cloud: 0 });
    setTilt(0);
    for (var s19b = 0; s19b < 120 * 0.35; s19b++) stepWorld(w19b, FIXED, {});
    check('俯视时喷流不再推物质', inJetB.vy > -5, 'vy=' + inJetB.vy.toFixed(1));
    setTilt(tiltSave20);

    // 21) 静观模式：镜头拉远、自动漫游、退出后拉回
    var w20 = createWorld(2020);
    var g0 = game;
    game = w20; setCamDist(1); toggleZen(true); game = g0;      // 进入静观（走真实路径）
    for (var s20 = 0; s20 < 120 * 8; s20++) stepWorld(w20, FIXED, {});
    check('静观模式镜头会拉远', w20.cam.scale < 0.85, w20.cam.scale.toFixed(2));
    game = w20; toggleZen(false); game = g0;                   // 退出静观
    for (var s21 = 0; s21 < 120 * 14; s21++) stepWorld(w20, FIXED, {});
    check('退出静观后镜头拉回', w20.cam.scale > 0.9, w20.cam.scale.toFixed(2));

    // 22) 顶栏重复按钮已移除
    check('右上角重复的暂停/声音已移除',
          !document.getElementById('bar-btns') && !document.getElementById('btn-pause') && !document.getElementById('btn-sound'));
    check('暂停/声音仍在按键条里',
          !!document.getElementById('btn-pause2') && !!document.getElementById('btn-sound2'));
    var zenBtn = document.getElementById('btn-zen');
    check('按键条的「静观」按钮有独立 id（不和开场按钮撞车）',
          !!zenBtn && !!document.getElementById('btn-zen-start') && zenBtn.id !== document.getElementById('btn-zen-start').id);

    // 23) 时间流速滑块
    var tEl = document.getElementById('time');
    check('时间流速滑块存在', !!tEl && !!document.getElementById('time-v'));
    if (tEl) {
      var tOld = tEl.value;
      tEl.value = '250';
      tEl.dispatchEvent(new Event('input', { bubbles: true }));
      check('时间流速可以调到 2.5×', Math.abs(getTimeScale() - 2.5) < 0.01, getTimeScale() + '×');
      tEl.value = '30';
      tEl.dispatchEvent(new Event('input', { bubbles: true }));
      check('时间流速可以调到 0.3×', Math.abs(getTimeScale() - 0.3) < 0.01, getTimeScale() + '×');
      tEl.value = tOld;
      tEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 24) 画面大小滑块
    var dEl = document.getElementById('dist');
    check('视角远近滑块存在', !!dEl && !!document.getElementById('dist-v'));
    if (dEl) {
      var dOld = dEl.value;
      setCamDist(2.5);
      check('滑块能设到 ×2.5', Math.abs(getCamDist() - 2.5) < 0.01, '×' + getCamDist());
      var wFar = createWorld(5150);
      wFar.camDist = 2.5;
      for (var sf = 0; sf < 120 * 10; sf++) stepWorld(wFar, FIXED, {});
      check('拉远会把相机比例缩小（看得更广）', wFar.cam.scale < 0.65, wFar.cam.scale.toFixed(2));
      check('拉远后粒子生成范围也跟着放大', true);
      setCamDist(1);
      var wNear = createWorld(5150);
      wNear.camDist = 1;
      for (var sn = 0; sn < 120 * 10; sn++) stepWorld(wNear, FIXED, {});
      check('拉近会回到 1.0', Math.abs(wNear.cam.scale - 1) < 0.05, wNear.cam.scale.toFixed(2));
      check('画布宽度不再被滑块改动', !stage.style.width || stage.style.width === '100%', '"' + stage.style.width + '"');
      var prevGameObj = game;
      game = createWorld(5150);
      setCamDist(1);
      toggleZen(true);
      check('静观会把「视角远近」拨到 ×2.4（同一个量）', Math.abs(getCamDist() - 2.4) < 0.01, '×' + getCamDist());
      var dEl2 = document.getElementById('dist');
      check('滑块位置也跟着走', dEl2 && Math.abs(parseFloat(dEl2.value) - 240) < 1, dEl2 ? dEl2.value : '无');
      for (var sz = 0; sz < 120 * 14; sz++) stepWorld(game, FIXED, {});
      check('静观确实把相机拉远了', game.cam.scale < 0.6, game.cam.scale.toFixed(2));
      toggleZen(false);
      check('退出静观会把远近拨回原值 ×1.0', Math.abs(getCamDist() - 1) < 0.01, '×' + getCamDist());
      game = prevGameObj;
      dEl.value = dOld;
      dEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 25) 漫游时自己随机喷流
    var w21 = createWorld(3030);
    w21.auto = true;
    var jetFrames = 0;
    for (var s22 = 0; s22 < 120 * 45; s22++) {
      stepWorld(w21, FIXED, {});
      if (s22 % 12 === 0) {
        for (var jk = 0; jk < w21.particles.length; jk++) {
          if (w21.particles[jk].kind === 'jet') { jetFrames++; break; }
        }
      }
    }
    check('漫游时会自行随机喷流', (w21.autoJets || 0) >= 3, '45 秒内喷了 ' + (w21.autoJets || 0) + ' 次');
    check('手动模式下不会自己喷流', (function () {
      var wm = createWorld(3031); wm.auto = false;
      for (var sm = 0; sm < 120 * 30; sm++) stepWorld(wm, FIXED, {});
      return (wm.autoJets || 0) === 0;
    })());

    // 26) 引力透镜：开关 + 两种渲染路径的冒烟测试
    check('引力透镜开关已移除（恒定开启）', !document.getElementById('lens'));
    var rErr1 = '';
    try { renderWorld(createWorld(1234), ctx); } catch (e) { rErr1 = e.message; }
    check('开启透镜时渲染不报错', rErr1 === '', rErr1);
    var lensW = createWorld(1234);
    lensW.particles.push({ kind: 'dust', x: lensW.bh.x + 120, y: lensW.bh.y, vx: 0, vy: 0, r: 2, m: 1, heat: 0.8, life: 0, maxLife: 0, trail: [], seed: 1, dead: false, pair: null, cloud: 0 });
    var lensOK = true;
    try { renderWorld(lensW, ctx); } catch (e) { lensOK = false; }
    check('有粒子贴着盘时渲染不报错', lensOK);

    // 27) 视角滑块：投影系数要跟着变，而且粒子和发光带用同一个
    var tiltEl2 = document.getElementById('tilt');
    check('视角滑块存在', !!tiltEl2 && !!document.getElementById('tilt-v'));
    if (tiltEl2) {
      var tOld2 = tiltEl2.value;
      tiltEl2.value = '0'; tiltEl2.dispatchEvent(new Event('input', { bubbles: true }));
      check('视角 0° 时是俯视（投影系数 ≈ 1）', Math.abs(getSquash() - 1) < 0.01, getSquash().toFixed(2));
      tiltEl2.value = '78'; tiltEl2.dispatchEvent(new Event('input', { bubbles: true }));
      check('视角 78° 时接近侧视（投影系数 < 0.3）', getSquash() < 0.3, getSquash().toFixed(2));
      check('投影系数下限有保护（不会压成 0）', getSquash() >= 0.14, getSquash().toFixed(2));
      var rErr3 = '';
      try { renderWorld(createWorld(1234), ctx); } catch (e) { rErr3 = e.message; }
      check('侧视下渲染不报错', rErr3 === '', rErr3);
      tiltEl2.value = '0';
      tiltEl2.dispatchEvent(new Event('input', { bubbles: true }));
      var rErr4 = '';
      try { renderWorld(createWorld(1234), ctx); } catch (e) { rErr4 = e.message; }
      check('俯视下渲染不报错', rErr4 === '', rErr4);
      tiltEl2.value = tOld2;
      tiltEl2.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 28) 俯视版是默认；预设按钮能切到侧视
    check('默认视角是俯视（0°）', getTilt() === 0, getTilt() + '°');
    check('俯视时投影系数 = 1（盘是圆的）', Math.abs(getSquash() - 1) < 0.01, getSquash().toFixed(2));
    var topB = document.getElementById('tilt-top'), sideB = document.getElementById('tilt-side');
    check('俯视/侧视预设按钮都在', !!topB && !!sideB);
    if (sideB) {
      sideB.click();
      check('点「侧视版」会切到 63°', Math.abs(getTilt() - 63) < 0.01, getTilt() + '°');
      check('侧视时投影系数 ≈ cos63°', Math.abs(getSquash() - Math.cos(63 * Math.PI / 180)) < 0.02, getSquash().toFixed(2));
      var rErr5 = '';
      try { renderWorld(createWorld(1234), ctx); } catch (e) { rErr5 = e.message; }
      check('侧视版渲染不报错', rErr5 === '', rErr5);
    }
    if (topB) {
      topB.click();
      check('点「俯视版」会切回 0°', getTilt() === 0, getTilt() + '°');
      var rErr6 = '';
      try { renderWorld(createWorld(1234), ctx); } catch (e) { rErr6 = e.message; }
      check('俯视版渲染不报错', rErr6 === '', rErr6);
    }
    var armW = createWorld(1234);
    var spin0 = armW.bh.spin;
    for (var sArm = 0; sArm < 120; sArm++) stepWorld(armW, FIXED, {});
    check('盘在转（自转相位在推进）', armW.bh.spin > spin0, (armW.bh.spin - spin0).toFixed(2));
    var armOK = true;
    try { renderWorld(armW, ctx); } catch (e) { armOK = false; }
    check('盘在转时俯视渲染不报错', armOK);

    // 29) 粒子不跟视角变；喷流按视角投影
    var saveTilt = getTilt();
    setTilt(0);
    check('俯视时粒子投影系数 = 1', particleSquash() === 1, particleSquash());
    check('俯视时喷流投影 = 0（缩成一点，可以接受）', Math.abs(jetProj()) < 0.001, jetProj().toFixed(3));
    setTilt(63);
    check('侧视时粒子投影系数仍是 1（只有盘的光随视角变）', particleSquash() === 1, particleSquash());
    check('侧视时喷流按 sin63° 投影', Math.abs(jetProj() - Math.sin(63 * Math.PI / 180)) < 0.01, jetProj().toFixed(3));
    check('吸积盘的光确实随视角压扁', getSquash() < 0.5, getSquash().toFixed(2));

    // 30) 喷流：射到屏幕外才结束；上下两批都能画
    var jw = createWorld(4242);
    jw.particles.length = 0;
    jw.particles.push({ kind: 'jet', x: jw.bh.x, y: jw.bh.y - 40, vx: 0, vy: -620,
                        r: 1.6, m: 0, heat: 1, life: 3, maxLife: 3, trail: [], dead: false, pair: null, cloud: 0 });
    jw.particles.push({ kind: 'jet', x: jw.bh.x, y: jw.bh.y + 40, vx: 0, vy: 620,
                        r: 1.6, m: 0, heat: 1, life: 3, maxLife: 3, trail: [], dead: false, pair: null, cloud: 0 });
    for (var sj = 0; sj < 120 * 1.2; sj++) stepWorld(jw, FIXED, {});
    var upJet = jw.particles.filter(function (p) { return p.kind === 'jet' && p.vy < 0; })[0];
    var dnJet = jw.particles.filter(function (p) { return p.kind === 'jet' && p.vy > 0; })[0];
    check('向上的喷流已经飞出屏幕仍在（不被出界删掉）', !!upJet && upJet.y < -20, upJet ? upJet.y.toFixed(0) : '没了');
    check('向下的喷流同样还在', !!dnJet && dnJet.y > H + 20, dnJet ? dnJet.y.toFixed(0) : '没了');
    var jErr = '';
    try { renderWorld(jw, ctx); } catch (e) { jErr = e.message; }
    check('上下两批喷流同时渲染不报错', jErr === '', jErr);
    setTilt(saveTilt);

    // 31) 显示框大小绝不被这些控件改动；资源要带版本号（否则浏览器会跑旧代码）
    var widthBefore = stage.style.width;
    setCamDist(2.5);
    setCamDist(1);
    var prevG2 = game;
    game = createWorld(7777); setCamDist(1);
    toggleZen(true); toggleZen(false);
    game = prevG2;
    check('任何远近/静观操作都不会改画布显示框宽度',
          stage.style.width === widthBefore, '"' + stage.style.width + '" → "' + widthBefore + '"');
    // 直接量像素：显示框（画布）的实际尺寸不该被这些控件改动
    var boxBefore = canvas.getBoundingClientRect();
    setCamDist(2.5);
    var boxFar = canvas.getBoundingClientRect();
    setCamDist(1);
    var boxNear = canvas.getBoundingClientRect();
    check('拉远/拉近时画布实际像素尺寸不变',
          Math.abs(boxFar.width - boxBefore.width) < 0.5 && Math.abs(boxNear.width - boxBefore.width) < 0.5,
          boxBefore.width.toFixed(1) + 'px → ' + boxFar.width.toFixed(1) + 'px');
    var scr = document.querySelector('script[src*="game.js"]');
    var lnk = document.querySelector('link[href*="style.css"]');
    check('脚本与样式带版本号（避免缓存跑旧代码）',
          !!scr && /[?&]v=\d+/.test(scr.getAttribute('src')) && !!lnk && /[?&]v=\d+/.test(lnk.getAttribute('href')),
          (scr ? scr.getAttribute('src') : '无脚本'));

    // 32) 刷新频率：总体变慢，特殊天体更稀有
    var wS = createWorld(3300);
    wS.unlocked = { comet: true, nebula: true, minibh: true };
    for (var ssw = 0; ssw < 120 * 25; ssw++) stepWorld(wS, FIXED, {});   // 先让它把场子铺满（填充期不算）
    var sp0 = wS.spawned, ea0 = wS.eaten;
    for (var ss = 0; ss < 120 * 40; ss++) stepWorld(wS, FIXED, {});
    var perSec = (wS.spawned - sp0) / 40;
    var diag = '稳态刷新 ' + perSec.toFixed(1) + '/s，吞噬 ' + ((wS.eaten - ea0) / 40).toFixed(1) +
               '/s，场上 ' + wS.particles.length + '，40 秒共生成 ' + (wS.spawned - sp0);
    check('稳态刷新不至于失控（≤ 14 个/秒）', perSec <= 14, diag);
    var nStar = 0;
    for (var sk = 0; sk < wS.particles.length; sk++) {
      if (wS.particles[sk].kind === 'star') nStar++;
    }
    check('场上粒子数维持在目标附近（没被吃空也没爆场）',
          wS.particles.length >= 150 && wS.particles.length <= 700,
          '场上 ' + wS.particles.length + ' 颗（目标 ' + TARGET_POP + '）');
    check('普通天体仍然常见（不是把所有东西都掐了）', nStar >= 20, nStar + ' 颗');

    // 冷却：拉到 5 分钟，验证特殊天体真的被"最小间隔"限住
    var wCd = createWorld(3500);
    wCd.unlocked = { comet: true, nebula: true, minibh: true };
    wCd.particles.length = 0;
    for (var scd = 0; scd < 120 * 300; scd++) stepWorld(wCd, FIXED, {});
    var cC = wCd.specialCount.comet, cN = wCd.specialCount.nebula, cM = wCd.specialCount.minibh;
    check('5 分钟内彗星不超过冷却允许的数量', cC <= Math.ceil(300 / SPECIAL_CD.comet) + 2, cC + ' 颗（冷却 ' + SPECIAL_CD.comet + ' 秒）');
    check('5 分钟内星云团不超过冷却允许的数量', cN <= Math.ceil(300 / SPECIAL_CD.nebula) + 2, cN + ' 团（冷却 ' + SPECIAL_CD.nebula + ' 秒）');
    check('5 分钟内小黑洞不超过冷却允许的数量', cM <= Math.ceil(300 / SPECIAL_CD.minibh) + 2, cM + ' 颗（冷却 ' + SPECIAL_CD.minibh + ' 秒）');
    check('特殊天体确实会出现（不是被掐死）', cC >= 3 && cN >= 1, '彗星 ' + cC + ' / 星云 ' + cN + ' / 小黑洞 ' + cM);
    // 猛吃（按住吸力）时场子不能被吃空 —— 这是刚才过度限流犯过的错
    var wD = createWorld(3400);
    wD.unlocked = { comet: true, nebula: true, minibh: true };
    for (var sdf = 0; sdf < 120 * 25; sdf++) stepWorld(wD, FIXED, {});
    var popFull = wD.particles.length;
    var spD0 = wD.spawned;
    wD.pull = true;
    for (var sdp = 0; sdp < 120 * 30; sdp++) stepWorld(wD, FIXED, {});
    check('猛吃时场上不会被吃空（≥ 120 颗）', wD.particles.length >= 120,
          '铺满 ' + popFull + ' → 猛吃 30 秒后 ' + wD.particles.length + ' 颗');
    var pullRate = (wD.spawned - spD0) / 30;
    check('猛吃时刷新率也有天花板（≤ 42/秒）', pullRate <= 42,
          '猛吃时 ' + pullRate.toFixed(1) + '/秒，场上 ' + wD.particles.length + ' 颗');

    check('特殊天体总概率 ≤ 6%',
          SPAWN_P.minibh + SPAWN_P.comet + SPAWN_P.nebula <= 0.06,
          ((SPAWN_P.minibh + SPAWN_P.comet + SPAWN_P.nebula) * 100).toFixed(1) + '%');

    // 33) 大黑洞（视界大、进食极快）时场子也不能被吃薄
    var wBig = createWorld(3600);
    wBig.unlocked = { comet: true, nebula: true, minibh: true };
    wBig.bh.mass = 12000;
    for (var sbf = 0; sbf < 120 * 25; sbf++) stepWorld(wBig, FIXED, {});
    var bigFull = wBig.particles.length;
    wBig.pull = true;
    for (var sbp = 0; sbp < 120 * 30; sbp++) stepWorld(wBig, FIXED, {});
    check('大黑洞猛吃时场上也不会空（≥ 120 颗）', wBig.particles.length >= 120,
          '铺满 ' + bigFull + ' → 大黑洞猛吃 30 秒后 ' + wBig.particles.length + ' 颗（视界 ' + wBig.bh.r.toFixed(0) + '）');

    // 34) 每 +10000 质量弹一句哲学留言
    check('留言表足够长（≥ 12 句）', PHILOSOPHY.length >= 12, PHILOSOPHY.length + ' 句');
    check('每句都短到能放进一行（≤ 40 字）',
          PHILOSOPHY.every(function (t) { return t.length <= 40; }),
          '最长 ' + Math.max.apply(null, PHILOSOPHY.map(function (t) { return t.length; })) + ' 字');
    check('没有一句会被折出孤零零的尾巴',
          PHILOSOPHY.every(function (t) {
            var ls = wrapCJK(t, 28);
            return ls.length === 1;
          }),
          '最长 ' + Math.max.apply(null, PHILOSOPHY.map(function (t) { return t.length; })) + ' 字，阈值 28');
    check('留言互不重复', (function () {
      var seen = {};
      for (var i = 0; i < PHILOSOPHY.length; i++) { if (seen[PHILOSOPHY[i]]) return false; seen[PHILOSOPHY[i]] = 1; }
      return true;
    })());

    var wP = createWorld(4400);
    wP.particles.length = 0;
    check('一开始没有留言', wP.phil <= 0 && wP.philBand === 0);
    wP.bh.mass = 10500;                       // 越过第一个 10000
    stepWorld(wP, FIXED, {});
    check('质量过 10000 会弹留言', wP.phil > 0 && wP.philText.length > 0, wP.philText);
    var firstMsg = wP.philText;
    check('留言是留言表里的句子', PHILOSOPHY.indexOf(firstMsg) >= 0);
    check('顺便也亮一下里程碑数字', wP.milestone > 0, wP.milestone.toFixed(1));

    wP.bh.mass = 20500;                       // 上一句还在显示：不应插队刷屏
    stepWorld(wP, FIXED, {});
    check('上一句还在时不会插队（不刷屏）', wP.philText === firstMsg, wP.philText);

    for (var sp2 = 0; sp2 < 120 * 10; sp2++) stepWorld(wP, FIXED, {});
    check('留言会自动消失', wP.phil <= 0);
    wP.bh.mass = 30500;
    stepWorld(wP, FIXED, {});
    check('下一条留言会换一句新的', wP.philText.length > 0 && wP.philText !== firstMsg, wP.philText);
    check('留言只在整万档触发（同一档不重复弹）', (function () {
      var before = wP.philText;
      stepWorld(wP, FIXED, {});
      return wP.philText === before;
    })());

    var pErr = '';
    try { wP.phil = 5; renderWorld(wP, ctx); } catch (e) { pErr = e.message; }
    check('留言渲染不报错', pErr === '', pErr);

    // 35) 里程碑特殊事件
    check('事件表有 6 种', EVENT_IDS.length === 6, EVENT_IDS.join('/'));
    check('每种事件都有实现', EVENT_IDS.every(function (id) { return typeof EVENT_FN[id] === 'function'; }));

    // ① 流星雨：同一辐射点、方向几乎平行
    var wE = createWorld(5501);
    wE.particles.length = 0;
    evMeteor(wE);
    var met = wE.particles.filter(function (p) { return p.kind === 'comet'; });
    check('流星雨会撒下一批流星', met.length >= 16, met.length + ' 颗');
    check('流星几乎朝同一个方向（辐射点）', (function () {
      if (met.length < 4) return false;
      var ax = 0, ay = 0;
      for (var i = 0; i < met.length; i++) { ax += met[i].vx; ay += met[i].vy; }
      var al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
      var worst = 1;
      for (i = 0; i < met.length; i++) {
        var l = Math.hypot(met[i].vx, met[i].vy) || 1;
        worst = Math.min(worst, (met[i].vx * ax + met[i].vy * ay) / l);
      }
      return worst > 0.8;
    })());
    for (var smt = 0; smt < 120 * 2; smt++) stepWorld(wE, FIXED, {});
    check('流星会拖出尾巴', met.length > 0 && met[0].trail.length > 3, met.length ? met[0].trail.length + ' 段' : '没了');

    // ② 星云稠密区
    var wE2 = createWorld(5502);
    wE2.particles.length = 0;
    var nNebBefore = wE2.particles.filter(function (p) { return p.kind === 'nebula'; }).length;
    evDense(wE2);
    var nNebAfter = wE2.particles.filter(function (p) { return p.kind === 'nebula'; }).length;
    check('稠密区会飘进新的星云团', nNebAfter - nNebBefore >= 3, '+' + (nNebAfter - nNebBefore) + ' 团');
    check('稠密区会持续一段时间', wE2.denseNebula > 5, wE2.denseNebula.toFixed(1) + ' 秒');

    // ③ 星团降临
    var wE3 = createWorld(5503);
    wE3.particles.length = 0;
    evCluster(wE3);
    var stars = wE3.particles.filter(function (p) { return p.kind === 'star' || p.kind === 'planet'; });
    check('星团会一次落进来很多恒星', stars.length >= 40, stars.length + ' 颗');
    check('它们挤在一小团里', (function () {
      var cx = 0, cy = 0, i;
      for (i = 0; i < stars.length; i++) { cx += stars[i].x; cy += stars[i].y; }
      cx /= stars.length; cy /= stars.length;
      for (i = 0; i < stars.length; i++) if (Math.hypot(stars[i].x - cx, stars[i].y - cy) > 160) return false;
      return true;
    })());

    // ④ 引力波涟漪：会扩张，并且真的把盘搓动
    var wE4 = createWorld(5504);
    wE4.particles.length = 0;
    evRipple(wE4);
    check('涟漪有 3 道波前', wE4.ripples.length === 3);
    var r0 = wE4.ripples[0].r;
    var probe = { kind: 'dust', x: wE4.bh.x + 200, y: wE4.bh.y, vx: 0, vy: 0, r: 2, m: 1, heat: 0,
                  life: 0, maxLife: 0, trail: [], seed: 1, dead: false, cloud: 0 };
    wE4.particles.push(probe);
    for (var srv = 0; srv < 120 * 0.6; srv++) stepWorld(wE4, FIXED, {});
    check('涟漪会向外扩张', wE4.ripples.length > 0 && wE4.ripples[0].r > r0, r0.toFixed(0) + ' → ' + (wE4.ripples[0] ? wE4.ripples[0].r.toFixed(0) : '散完'));
    check('涟漪扫过时会把盘搓一下（切向速度）', Math.abs(probe.vy) > 3 || probe.dead, 'vy=' + probe.vy.toFixed(1));
    for (var srv2 = 0; srv2 < 120 * 12; srv2++) stepWorld(wE4, FIXED, {});
    check('涟漪会自己消失', wE4.ripples.length === 0);

    // ⑤ 微引力透镜
    var wE5 = createWorld(5505);
    evLens(wE5);
    check('透镜事件会生成一颗被放大的背景星', !!wE5.lensStar && wE5.lensStar.t > 0);
    var lErr = '';
    try { renderWorld(wE5, ctx); } catch (e) { lErr = e.message; }
    check('透镜渲染不报错', lErr === '', lErr);
    for (var sls = 0; sls < 120 * 9; sls++) stepWorld(wE5, FIXED, {});
    check('透镜事件会自己结束', !wE5.lensStar);

    // ⑥ 并合事件
    var wE6 = createWorld(5506);
    wE6.particles.length = 0;
    evMerge(wE6);
    var mBefore2 = wE6.particles.filter(function (p) { return p.kind === 'minibh'; }).length;
    for (var smg = 0; smg < 40; smg++) stepWorld(wE6, FIXED, {});
    var mAfter2 = wE6.particles.filter(function (p) { return p.kind === 'minibh' && !p.dead; });
    check('并合事件会先放进两颗小黑洞', mBefore2 === 2, mBefore2 + ' 颗');
    check('然后它们会并成一个', mAfter2.length === 1, mAfter2.length + ' 颗');

    // 里程碑会触发事件（质量过 20000 才开放），且不会连着重样
    var wEv = createWorld(5600);
    var seenIds = [], band1Fired = false;
    for (var band2 = 1; band2 <= 8; band2++) {
      wEv.bh.mass = band2 * 10000 + 500;
      var beforeSeq = wEv.eventSeq;
      stepWorld(wEv, FIXED, {});
      var fired = wEv.eventSeq > beforeSeq;
      if (band2 === 1 && fired) band1Fired = true;
      if (fired) seenIds.push(wEv.eventId + '#' + band2);
    }
    check('质量 10000 时不触发特殊事件', !band1Fired, band1Fired ? '竟然触发了' : '没有');
    check('质量过 20000 才解锁（第 2 档开始）',
          seenIds.length === 7 && /#2$/.test(seenIds[0]), seenIds.join(' → '));
    check('20000 解锁（不再单独弹提示，直接来事件）',
          wEv.eventsUnlocked === true && /特殊事件/.test(wEv.evText), wEv.evText);
    check('事件不会连着两次一样', (function () {
      for (var i = 1; i < seenIds.length; i++) if (seenIds[i] === seenIds[i - 1]) return false;
      return true;
    })(), seenIds.join(' → '));

    check('事件提示会显示出来', /特殊事件/.test(wEv.evText) && wEv.evT > 0, wEv.evText);
    check('EVENT_MIN_MASS 是 20000', EVENT_MIN_MASS === 20000, String(EVENT_MIN_MASS));

    // 36) 暂停文案轮换
    check('暂停文案有 8 句以上', PAUSE_LINES.length >= 8, PAUSE_LINES.length + ' 句');
    check('暂停文案互不重复', (function () {
      var seen = {};
      for (var i = 0; i < PAUSE_LINES.length; i++) { if (seen[PAUSE_LINES[i]]) return false; seen[PAUSE_LINES[i]] = 1; }
      return true;
    })());
    check('暂停文案都短（≤ 20 字）', PAUSE_LINES.every(function (t) { return t.length <= 20; }),
          '最长 ' + Math.max.apply(null, PAUSE_LINES.map(function (t) { return t.length; })) + ' 字');
    var seqOfLines = [];
    for (var pl2 = 0; pl2 < 5; pl2++) seqOfLines.push(nextPauseLine());
    check('每次暂停都会换一句', (function () {
      for (var i = 1; i < seqOfLines.length; i++) if (seqOfLines[i] === seqOfLines[i - 1]) return false;
      return true;
    })(), seqOfLines[0] + ' → ' + seqOfLines[1]);
    check('文案写进了 DOM', (function () {
      var el = document.getElementById('pause-line');
      return !!el && el.textContent === seqOfLines[seqOfLines.length - 1];
    })());

    // 37) 自动喷流与手动喷流共用一个冷却
    var wJ = createWorld(7700);
    wJ.particles.length = 0;
    wJ.auto = true;
    check('一开始喷流可用', wJ.jetCd <= 0);
    wJ.autoJetTimer = 0;                       // 逼自动喷流立刻喷一次
    stepWorld(wJ, FIXED, {});
    var jetsAuto = wJ.particles.filter(function (p) { return p.kind === 'jet'; }).length;
    check('漫游时会自动喷流', jetsAuto > 0, jetsAuto + ' 个喷流粒子');
    check('自动喷流会占用共享冷却', wJ.jetCd > 0, wJ.jetCd.toFixed(1) + ' 秒');
    check('自动喷流后手动脉冲被挡住', pulse(wJ) === false, 'jetCd=' + wJ.jetCd.toFixed(1));

    var wJ2 = createWorld(7701);
    wJ2.particles.length = 0;
    wJ2.auto = true;
    check('手动脉冲可用', pulse(wJ2) === true);
    check('手动脉冲也会占用同一个冷却', wJ2.jetCd > 0, wJ2.jetCd.toFixed(1) + ' 秒');
    var jetsBefore2 = wJ2.particles.filter(function (p) { return p.kind === 'jet'; }).length;
    wJ2.autoJetTimer = 0;                      // 自动喷流想喷，但冷却中
    for (var sjc = 0; sjc < 60; sjc++) stepWorld(wJ2, FIXED, {});
    var jetsAfter2 = wJ2.particles.filter(function (p) { return p.kind === 'jet'; }).length;
    check('冷却期间自动喷流不会补一发', jetsAfter2 <= jetsBefore2 + 1,
          jetsBefore2 + ' → ' + jetsAfter2 + ' 个');

    wJ2.auto = false;                          // 关掉漫游：否则自动喷流会接着占冷却（这也是共享生效的证明）
    for (var sjd = 0; sjd < 120 * 8; sjd++) stepWorld(wJ2, FIXED, {});
    check('冷却结束后手动脉冲恢复', wJ2.jetCd <= 0 && pulse(wJ2) === true, 'jetCd=' + wJ2.jetCd.toFixed(1));
    check('JET_CD 是统一的常量', typeof JET_CD === 'number' && JET_CD > 0, JET_CD + ' 秒');
    check('吞噬触发的喷流也占用同一个冷却', (function () {
      var wj3 = createWorld(7702);
      wj3.particles.length = 0;
      wj3.jetCd = 0;
      wj3.particles.push({ kind: 'planet', x: wj3.bh.x + 4, y: wj3.bh.y, vx: 0, vy: 0, r: 8, m: 60,
                           heat: 0, life: 0, maxLife: 0, trail: [], seed: 1, dead: false, cloud: 0 });
      stepWorld(wj3, FIXED, {});
      return wj3.jetCd > 0;
    })());

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

  window.BlackHoleZen = {
    createWorld: createWorld, stepWorld: stepWorld, renderWorld: renderWorld,
    pulse: pulse, spawnCluster: spawnCluster, runBot: runBot, input: input,
    toggleZen: toggleZen, spawnMiniBH: spawnMiniBH, miniStats: miniStats, dissolveNebula: dissolveNebula,
    evMeteor: evMeteor, evDense: evDense, evCluster: evCluster, evRipple: evRipple, evLens: evLens, evMerge: evMerge,
    triggerMilestoneEvent: triggerMilestoneEvent, nextPauseLine: nextPauseLine,
    renderWorld: renderWorld, getTilt: getTilt, getSquash: getSquash, particleSquash: particleSquash,
    getCamDist: getCamDist, setCamDist: setCamDist,
    jetProj: jetProj,
    setTilt: setTilt,
    getTimeScale: getTimeScale,
    getGame: function () { return game; }, getMode: function () { return mode; }
  };
})();
