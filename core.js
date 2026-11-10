'use strict';
// NFL Conquest Map - core: shared state, helpers, county geometry decoding, data model, game replay.
// (core.js, render.js and ui.js share one global scope on purpose; load order is set in index.html.)

var TAG = 'NFLConquest: ';
var BG = '#f4f2ec';

var PALETTE = {
  ARI: '#97233F', ATL: '#E4262F', BAL: '#5B2C9F', BUF: '#2563EB', CAR: '#0AA5DC', CHI: '#E8590C',
  CIN: '#FB7C13', CLE: '#6B3A1E', DAL: '#1B2F5E', DEN: '#FF6A13', DET: '#5AB0F0', GB: '#1F8A43',
  HOU: '#A71930', IND: '#1D4E9E', JAX: '#0E8F8F', KC: '#D91E36', LA: '#2F4BE0', LAC: '#35B8F5',
  LV: '#111318', MIA: '#12C7B8', MIN: '#7C3AED', NE: '#0B2A5B', NO: '#CDB87A', NYG: '#2B4BB3',
  NYJ: '#146B3A', PHI: '#0E7C66', PIT: '#FFC72C', SEA: '#0A2342', SF: '#B3122B', TB: '#8E1B1B',
  TEN: '#5FA8E8', WAS: '#7A1F3D'
};

var FIELD_RULES = [
  ['kind', /^row kind|^kind$/], ['key', /^row key$|^key$/], ['team', /^team$/], ['opp', /^opponent$|^opp$/],
  ['name', /^name( \(team|$)/], ['region', /^map region|^region$/], ['state', /^state$/],
  ['terr', /^territory \(its|^terr$/], ['lat', /^latitude$|^lat$/], ['lon', /^longitude$|^lon$/],
  ['page', /^page( \(0|$)/], ['slot', /^order within|^slot$/], ['ptsw', /^winner points|^pts_w$/],
  ['ptsl', /^loser points|^pts_l$/]
];

var worksheet = null;
var TOPO = null;           // decoded county geometry (lon/lat)
var M = null;              // data model
var D = {};                // dom handles
var S = {                  // view state
  page: 0, owner: null, segs: null, changed: [], tl: null, pendingPage: null, animEnd: 0, playing: false, speed: 1,
  pin: -1, hoverRow: -1, hoverTeam: -1, live: null, disp: null, holdUntil: 0, lastRank: null,
  layout: null, layoutId: 0, dirty: true, shownPage: -1, ownerVersion: 0,
  logos: null, logoMoving: false, logoFocus: -2, baseKey: '', linesKey: -1, oc: null, dpr: 1
};

// ---------- helpers ----------
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOut(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function now() { return performance.now(); }
function describeError(err) { return (err && err.message) ? err.message : String(err); }
function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lum(h) { var c = hexRgb(h); return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
function ink(h) { return lum(h) > 0.58 ? '#0b0f17' : '#ffffff'; }
function rgba(h, a) { var c = hexRgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
function mixRgb(a, b, t) {
  return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' + Math.round(a[2] + (b[2] - a[2]) * t) + ')';
}
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  var k = function (n) { return (n + h / 30) % 12; };
  var a = s * Math.min(l, 1 - l);
  var f = function (n) { return Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))); };
  return '#' + [f(0), f(8), f(4)].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
}
function colorOf(code) {
  if (PALETTE[code]) return PALETTE[code];
  var h = 0, i; for (i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return hslHex(h, 55, 45);
}
function pageLabel(p) { return p === 0 ? 'Preseason' : 'Week ' + p; }
function pageShort(p) { return p === 0 ? 'PRE' : String(p); }
// JS animations are not covered by the CSS reduced-motion block, so they ask here (read live: the setting can change mid-session)
function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
function speedMs(ms) { return reducedMotion() ? Math.min(ms / S.speed, 60) : ms / S.speed; }
// marks that stand for data settle fast; chrome that follows the cursor trails
function placeInstantly(e, transform) {
  e.classList.add('no-tr');
  e.style.transform = transform;
  void e.offsetWidth;                    // flush so the class can come off without batching away the jump
  e.classList.remove('no-tr');
}

function showMsg(t) {
  D.msg.textContent = t; D.msg.style.display = t ? 'block' : 'none';
  if (t) { D.loading.style.display = 'none'; console.error(TAG + t); }
}

// ---------- county geometry (TopoJSON) ----------
function decodeTopo(topo) {
  var sc = topo.transform.scale, tr = topo.transform.translate;
  var arcs = topo.arcs.map(function (a) {
    var x = 0, y = 0, n = a.length, out = new Float64Array(n * 2), i;
    for (i = 0; i < n; i++) { x += a[i][0]; y += a[i][1]; out[i * 2] = x * sc[0] + tr[0]; out[i * 2 + 1] = y * sc[1] + tr[1]; }
    return out;
  });
  var counties = [], arcUse = new Array(arcs.length);
  topo.objects.counties.geometries.forEach(function (g) {
    var id = String(g.id), st = id.length >= 5 ? id.slice(0, id.length - 3) : id;
    if (parseInt(st, 10) > 56) return;                       // drop territories
    var polys = g.type === 'Polygon' ? [g.arcs] : g.arcs, c = counties.length, rings = [];
    polys.forEach(function (poly) { poly.forEach(function (ring) { rings.push(ring); }); });
    rings.forEach(function (ring) {
      ring.forEach(function (r) { var a = r < 0 ? ~r : r; (arcUse[a] || (arcUse[a] = [])).push(c); });
    });
    counties.push({ id: id, st: st.length === 1 ? '0' + st : st, rings: rings });
  });
  counties.forEach(function (c) {          // centre of the largest ring's bounding box
    var best = null, bs = -1;
    c.rings.forEach(function (ring) {
      var pts = ringPoints(arcs, ring), x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, i;
      for (i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
      var sz = (x1 - x0) * (y1 - y0);
      if (sz > bs) { bs = sz; best = [(x0 + x1) / 2, (y0 + y1) / 2]; }
    });
    c.lon = best ? best[0] : 0; c.lat = best ? best[1] : 0;
    c.grp = c.st === '02' ? 'A' : (c.st === '15' ? 'H' : 'L');
    if (c.grp === 'A' && c.lon > 0) c.lon -= 360;
  });
  return { arcs: arcs, counties: counties, arcUse: arcUse };
}

function ringPoints(arcs, ring) {
  var out = [], k, i, a, n;
  for (k = 0; k < ring.length; k++) {
    var r = ring[k], rev = r < 0; a = arcs[rev ? ~r : r]; n = a.length / 2;
    for (i = 0; i < n; i++) {
      if (k > 0 && i === 0) continue;
      var j = rev ? n - 1 - i : i;
      out.push(a[j * 2], a[j * 2 + 1]);
    }
  }
  return out;
}

// ---------- model ----------
function norm(n) {
  return String(n).replace(/^\s*(sum|avg|min|max|attr|agg|cnt|cntd|usr|none)\s*\((.*)\)\s*$/i, '$2').trim().toLowerCase();
}
function sv(r, i) {
  if (i == null) return '';
  var v = r[i].value;
  if (v == null || v === '%null%') return '';
  return String(v);
}
function nv(r, i) {
  if (i == null) return NaN;
  var v = r[i].value;
  if (v == null || v === '%null%' || v === '') return NaN;
  return Number(v);
}

function buildModel(data) {
  var idx = {}, wIdx = [], missing = [];
  data.columns.forEach(function (c, i) {
    var n = norm(c.fieldName), k, m;
    for (k = 0; k < FIELD_RULES.length; k++) {
      if (idx[FIELD_RULES[k][0]] === undefined && FIELD_RULES[k][1].test(n)) { idx[FIELD_RULES[k][0]] = i; return; }
    }
    m = /^(?:owner after page |w)(\d+)$/.exec(n);
    if (m) wIdx[+m[1]] = i;
  });
  ['kind', 'lat', 'lon', 'terr'].forEach(function (k) { if (idx[k] === undefined) missing.push(k); });
  var hasW = wIdx.some(function (x) { return x !== undefined; });
  if (missing.length || !hasW) {
    showMsg('Add these fields to Detail: ' + missing.join(', ') + (hasW ? '' : ' and the Owner after page columns'));
    return null;
  }
  showMsg('');

  var tilesRaw = [], terrRows = {}, names = {}, games = [];
  data.data.forEach(function (r) {
    var kind = sv(r, idx.kind), code;
    if (kind === 'tile') {
      var la = nv(r, idx.lat), lo = nv(r, idx.lon);
      if (isFinite(la) && isFinite(lo)) tilesRaw.push({ lat: la, lon: lo, region: sv(r, idx.region), state: sv(r, idx.state), terr: sv(r, idx.terr) });
    } else if (kind === 'terr') {
      code = sv(r, idx.terr);
      names[code] = sv(r, idx.name) || code;
      var ow = [];
      wIdx.forEach(function (ci, p) { if (ci !== undefined) ow[p] = sv(r, ci); });
      terrRows[code] = ow;
    } else if (kind === 'team') {
      code = sv(r, idx.team);
      if (code && sv(r, idx.name)) names[code] = sv(r, idx.name);
    } else if (kind === 'game') {
      games.push({ page: nv(r, idx.page), slot: nv(r, idx.slot), w: sv(r, idx.team), l: sv(r, idx.opp), pw: nv(r, idx.ptsw), pl: nv(r, idx.ptsl) });
    }
  });

  var codes = Object.keys(terrRows).sort(), tIdx = {}, maxPage = 0, p, t;
  codes.forEach(function (c, i) { tIdx[c] = i; });
  wIdx.forEach(function (ci, pg) { if (ci !== undefined && pg > maxPage) maxPage = pg; });

  var ownerByPage = [];
  for (p = 0; p <= maxPage; p++) {
    var arr = new Int16Array(codes.length);
    for (t = 0; t < codes.length; t++) {
      var o = terrRows[codes[t]][p];
      if (o && tIdx[o] !== undefined) arr[t] = tIdx[o];
      else arr[t] = p === 0 ? t : ownerByPage[p - 1][t];
    }
    ownerByPage.push(arr);
  }

  var tiles = tilesRaw.filter(function (x) { return tIdx[x.terr] !== undefined; });
  var terrTiles = codes.map(function () { return []; });
  tiles.forEach(function (x, i) {
    x.t = tIdx[x.terr]; terrTiles[x.t].push(i);
    x.grp = x.region === 'AK' ? 'A' : (x.region === 'HI' ? 'H' : 'L');
  });
  var terrSize = terrTiles.map(function (a) { return a.length; });
  var teams = codes.map(function (c, i) {
    var col = colorOf(c);
    return { code: c, name: names[c] || c, color: col, rgb: hexRgb(col), idx: i };
  });

  var model = {
    teams: teams, tIdx: tIdx, tiles: tiles, nTiles: tiles.length, terrTiles: terrTiles, terrSize: terrSize,
    ownerByPage: ownerByPage, maxPage: maxPage, games: games, events: [], countsByPage: [], aliveByPage: [], elimSeq: {},
    cTile: mapCountiesToTiles(tiles)
  };
  model.countsByPage = ownerByPage.map(function (ow) { return countsOf(model, ow); });
  model.aliveByPage = model.countsByPage.map(function (c) { var n = 0; for (var i = 0; i < c.length; i++) if (c[i] > 0) n++; return n; });
  buildAllEvents(model);
  return model;
}

// each county takes the owner of its nearest tile (same region group only)
function mapCountiesToTiles(tiles) {
  var out = new Int32Array(TOPO.counties.length), c, i;
  for (c = 0; c < TOPO.counties.length; c++) {
    var co = TOPO.counties[c], best = -1, bd = 1e18, k = Math.cos(co.lat * Math.PI / 180);
    for (i = 0; i < tiles.length; i++) {
      if (tiles[i].grp !== co.grp) continue;
      var dx = (tiles[i].lon - co.lon) * k, dy = tiles[i].lat - co.lat, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    out[c] = best;
  }
  return out;
}

function countsOf(model, ow) {
  var c = new Int32Array(model.teams.length), t;
  for (t = 0; t < ow.length; t++) c[ow[t]] += model.terrSize[t];
  return c;
}

// replay each week's games in slot order (a winner takes everything its opponent holds)
function buildAllEvents(model) {
  var seq = 0, p;
  model.events = [[]];
  for (p = 1; p <= model.maxPage; p++) {
    var cur = model.ownerByPage[p - 1].slice(), counts = new Int32Array(model.countsByPage[p - 1]), evs = [];
    var gs = model.games.filter(function (g) { return g.page === p; }).sort(function (a, b) { return a.slot - b.slot; });
    gs.forEach(function (g) {
      var w = model.tIdx[g.w], l = model.tIdx[g.l], T, moved = [], wTerrs = [], n = 0;
      g.ev = null;
      if (w === undefined || l === undefined || w === l) return;
      for (T = 0; T < cur.length; T++) { if (cur[T] === l) moved.push(T); if (cur[T] === w) wTerrs.push(T); }
      if (!moved.length) return;
      moved.forEach(function (x) { cur[x] = w; n += model.terrSize[x]; });
      var before = counts[l];
      counts[w] += n; counts[l] -= n;
      var ev = { game: g, winner: w, loser: l, terrs: moved, wTerrs: wTerrs, n: n, elim: before > 0 && counts[l] === 0, seq: ++seq };
      if (ev.elim && model.elimSeq[l] === undefined) model.elimSeq[l] = seq;
      g.ev = ev;
      evs.push(ev);
    });
    var ok = true, target = model.ownerByPage[p];
    for (var T2 = 0; T2 < cur.length; T2++) if (cur[T2] !== target[T2]) { ok = false; break; }
    if (!ok) {
      console.warn(TAG + 'page ' + p + ' game replay differs from owner columns; using diff events');
      evs = diffEvents(model, p, function () { return ++seq; });
    }
    model.events.push(evs);
  }
}

function diffEvents(model, p, nextSeq) {
  var prev = model.ownerByPage[p - 1], cur = model.ownerByPage[p], groups = {}, order = [], T;
  var counts = new Int32Array(model.countsByPage[p - 1]);
  for (T = 0; T < cur.length; T++) {
    if (prev[T] !== cur[T]) {
      var k = prev[T] + '>' + cur[T];
      if (!groups[k]) { groups[k] = { winner: cur[T], loser: prev[T], terrs: [], n: 0 }; order.push(k); }
      groups[k].terrs.push(T); groups[k].n += model.terrSize[T];
    }
  }
  return order.map(function (k) {
    var g = groups[k], before = counts[g.loser], wT = [], i;
    counts[g.winner] += g.n; counts[g.loser] -= g.n;
    for (i = 0; i < prev.length; i++) if (prev[i] === g.winner) wT.push(i);
    var ev = { game: null, winner: g.winner, loser: g.loser, terrs: g.terrs, wTerrs: wT, n: g.n, elim: before > 0 && counts[g.loser] === 0, seq: nextSeq() };
    if (ev.elim && model.elimSeq[g.loser] === undefined) model.elimSeq[g.loser] = ev.seq;
    return ev;
  });
}

function ownerArray(page) {
  var out = new Int16Array(M.nTiles), ow = M.ownerByPage[page], i;
  for (i = 0; i < M.nTiles; i++) out[i] = ow[M.tiles[i].t];
  return out;
}
