'use strict';
// NFL Conquest Map - render: projection/layout, layered canvas drawing, connected-territory logos, effects.

// ---------- projection + layout ----------
function albers(lon0, lat0, p1, p2) {
  var r = Math.PI / 180, s1 = Math.sin(p1 * r), s2 = Math.sin(p2 * r);
  var n = (s1 + s2) / 2, C = Math.cos(p1 * r) * Math.cos(p1 * r) + 2 * n * s1;
  var rho0 = Math.sqrt(C - 2 * n * Math.sin(lat0 * r)) / n;
  return function (lon, lat) {
    var rho = Math.sqrt(C - 2 * n * Math.sin(lat * r)) / n, th = n * (lon - lon0) * r;
    return [rho * Math.sin(th), rho * Math.cos(th) - rho0];     // y grows southward (screen-style)
  };
}

function addArc(path, flat) {
  var n = flat.length / 2, i;
  for (i = 0; i < n; i++) { if (i) path.lineTo(flat[i * 2], flat[i * 2 + 1]); else path.moveTo(flat[0], flat[1]); }
}

function computeLayout(W, H) {
  var arcs = TOPO.arcs, cos = TOPO.counties, arcUse = TOPO.arcUse, tiles = M.tiles, i, c, a;
  var proj = { L: albers(-96, 37.5, 29.5, 45.5), A: albers(-154, 50, 55, 65), H: albers(-157, 13, 8, 18) };
  var bb = { L: [1e9, 1e9, -1e9, -1e9], A: [1e9, 1e9, -1e9, -1e9], H: [1e9, 1e9, -1e9, -1e9] };
  var arcGrp = new Array(arcs.length), rawArcs = new Array(arcs.length);
  for (a = 0; a < arcs.length; a++) {
    var users = arcUse[a];
    if (!users) continue;
    var g = cos[users[0]].grp, flat = arcs[a], n = flat.length / 2, raw = new Float64Array(flat.length), b = bb[g], k;
    for (k = 0; k < n; k++) {
      var lo = flat[k * 2];
      if (g === 'A' && lo > 0) lo -= 360;
      var pt = proj[g](lo, flat[k * 2 + 1]);
      raw[k * 2] = pt[0]; raw[k * 2 + 1] = pt[1];
      if (pt[0] < b[0]) b[0] = pt[0]; if (pt[1] < b[1]) b[1] = pt[1];
      if (pt[0] > b[2]) b[2] = pt[0]; if (pt[1] > b[3]) b[3] = pt[1];
    }
    arcGrp[a] = g; rawArcs[a] = raw;
  }
  // Alaska and Hawaii sit in a row beneath the lower 48, clear of the timeline and clear of each other.
  // Reserve bottom room for them, sized from their own projected extents (two passes: the inset size depends on the map scale).
  var padL = 24, padR = 24, padT = 112, CTRL = 92, padB = 112;
  var aw = Math.max(50, W - padL - padR), rw = bb.L[2] - bb.L[0], rh = bb.L[3] - bb.L[1], pass, ah, s;
  var insAw = Math.max(0, bb.A[2] - bb.A[0]), insAh = Math.max(0, bb.A[3] - bb.A[1]);
  var insHw = Math.max(0, bb.H[2] - bb.H[0]), insHh = Math.max(0, bb.H[3] - bb.H[1]);
  for (pass = 0; pass < 3; pass++) {
    ah = Math.max(50, H - padT - padB); s = Math.min(aw / rw, ah / rh);
    padB = CTRL + 0.6 * Math.max(insAh * s * 0.33, insHh * s * 0.95);
  }
  var x0 = padL + (aw - rw * s) / 2, y0 = padT + (ah - rh * s) / 2, Wd = rw * s, Hd = rh * s;
  var aS = s * 0.33, hS = s * 0.95, insetBottom = H - CTRL, gap = Math.max(32, Wd * 0.06);
  var aLeft = x0 + Wd * 0.02, hLeft = aLeft + insAw * aS + gap;
  var aT = [aLeft + insAw * aS / 2, insetBottom - insAh * aS / 2], hT = [hLeft + insHw * hS / 2, insetBottom - insHh * hS / 2];
  function toScreen(g2, x, y) {
    if (g2 === 'L') return [x0 + (x - bb.L[0]) * s, y0 + (y - bb.L[1]) * s];
    if (g2 === 'A') return [aT[0] + (x - (bb.A[0] + bb.A[2]) / 2) * aS, aT[1] + (y - (bb.A[1] + bb.A[3]) / 2) * aS];
    return [hT[0] + (x - (bb.H[0] + bb.H[2]) / 2) * hS, hT[1] + (y - (bb.H[1] + bb.H[3]) / 2) * hS];
  }

  var scrArcs = new Array(arcs.length);
  for (a = 0; a < arcs.length; a++) {
    var ra = rawArcs[a]; if (!ra) continue;
    var out = new Float32Array(ra.length), gg = arcGrp[a], q;
    for (i = 0; i < ra.length; i += 2) { q = toScreen(gg, ra[i], ra[i + 1]); out[i] = q[0]; out[i + 1] = q[1]; }
    scrArcs[a] = out;
  }

  // county fill paths, bounding-box centres and areas
  var nc = cos.length, cPath = new Array(nc), cBx = new Float64Array(nc), cBy = new Float64Array(nc), cArea = new Float64Array(nc);
  for (c = 0; c < nc; c++) {
    var path = new Path2D(), x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9, signed = 0;
    cos[c].rings.forEach(function (ring) {
      var first = true, kk, jj, fx = 0, fy = 0, lx = 0, ly = 0;
      for (kk = 0; kk < ring.length; kk++) {
        var rr = ring[kk], rev = rr < 0, fl = scrArcs[rev ? ~rr : rr]; if (!fl) continue;
        var nn = fl.length / 2;
        for (jj = 0; jj < nn; jj++) {
          if (kk > 0 && jj === 0) continue;
          var ix = rev ? nn - 1 - jj : jj, X = fl[ix * 2], Y = fl[ix * 2 + 1];
          if (first) { path.moveTo(X, Y); first = false; fx = X; fy = Y; } else { path.lineTo(X, Y); signed += lx * Y - X * ly; }
          lx = X; ly = Y;
          if (X < x1) x1 = X; if (X > x2) x2 = X; if (Y < y1) y1 = Y; if (Y > y2) y2 = Y;
        }
      }
      signed += lx * fy - fx * ly;
      path.closePath();
    });
    cPath[c] = path; cBx[c] = (x1 + x2) / 2; cBy[c] = (y1 + y2) / 2; cArea[c] = Math.abs(signed) / 2;
  }

  // adjacency (counties sharing an arc), state lines, coastline
  var stateLines = new Path2D(), coast = new Path2D(), arcList = [], cAdj = new Array(nc);
  for (c = 0; c < nc; c++) cAdj[c] = [];
  for (a = 0; a < arcs.length; a++) {
    var u = arcUse[a], fa = scrArcs[a]; if (!u || !fa) continue;
    var ca = u[0], cb = u.length > 1 ? u[1] : -1;
    if (cb < 0 || ca === cb) { addArc(coast, fa); arcList.push([a, ca, -1]); continue; }
    if (cos[ca].st !== cos[cb].st) addArc(stateLines, fa);
    arcList.push([a, ca, cb]);
    cAdj[ca].push(cb); cAdj[cb].push(ca);
  }

  // sampled coastline points: the nation's edge counts as a boundary when placing logos
  var cp = [];
  arcList.forEach(function (en) {
    if (en[2] >= 0) return;
    var fl = scrArcs[en[0]], m;
    for (m = 0; m < fl.length; m += 6) cp.push(fl[m], fl[m + 1]);
  });
  var coastPts = new Float32Array(cp);

  // tiles in screen space (seats, hover)
  var n2 = tiles.length, px = new Float64Array(n2), py = new Float64Array(n2);
  for (i = 0; i < n2; i++) {
    var tl = tiles[i], lon = tl.lon;
    if (tl.grp === 'A' && lon > 0) lon -= 360;
    var rp = proj[tl.grp](lon, tl.lat), sp = toScreen(tl.grp, rp[0], rp[1]);
    px[i] = sp[0]; py[i] = sp[1];
  }
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (i = 0; i < n2; i++) { minX = Math.min(minX, px[i]); minY = Math.min(minY, py[i]); maxX = Math.max(maxX, px[i]); maxY = Math.max(maxY, py[i]); }
  var cs = Math.max(4, Math.sqrt(((maxX - minX) * (maxY - minY)) / Math.max(1, n2)) * 1.4);
  var gw = Math.ceil((maxX - minX) / cs) + 1, gh = Math.ceil((maxY - minY) / cs) + 1, grid = new Array(gw * gh);
  for (i = 0; i < n2; i++) { var kx = Math.floor((px[i] - minX) / cs) + Math.floor((py[i] - minY) / cs) * gw; (grid[kx] || (grid[kx] = [])).push(i); }

  S.layoutId++;
  return { id: S.layoutId, W: W, H: H, px: px, py: py, grid: grid, gw: gw, gh: gh, cs: cs, minX: minX, minY: minY, scale: s,
    cPath: cPath, cBx: cBx, cBy: cBy, cArea: cArea, cAdj: cAdj, stateLines: stateLines, coast: coast, coastPts: coastPts, arcList: arcList,
    scrArcs: scrArcs, arcPaths: {}, compCache: {} };
}

function arcPath(L, a) {
  var p = L.arcPaths[a];
  if (!p) { p = new Path2D(); addArc(p, L.scrArcs[a]); L.arcPaths[a] = p; }
  return p;
}

function ensureLayout() {
  if (!M || !TOPO) return null;
  var W = D.map.clientWidth, H = D.map.clientHeight;
  if (!W || !H) return null;
  if (!S.layout || S.layout.W !== W || S.layout.H !== H) { S.layout = computeLayout(W, H); S.logos = null; S.dirty = true; }
  return S.layout;
}

function seatOf(L, tileIdx) {
  var cx = 0, cy = 0, n = tileIdx.length, i, best = -1, bd = 1e18;
  if (!n) return [L.W / 2, L.H / 2];
  for (i = 0; i < n; i++) { cx += L.px[tileIdx[i]]; cy += L.py[tileIdx[i]]; }
  cx /= n; cy /= n;
  for (i = 0; i < n; i++) { var dx = L.px[tileIdx[i]] - cx, dy = L.py[tileIdx[i]] - cy, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = tileIdx[i]; } }
  return [L.px[best], L.py[best]];
}
function tilesOfTerrs(list) {
  var out = [];
  list.forEach(function (T) { var a = M.terrTiles[T]; for (var i = 0; i < a.length; i++) out.push(a[i]); });
  return out;
}

// ---------- canvas + layers ----------
function resizeCanvas() {
  var dpr = window.devicePixelRatio || 1, w = D.stage.clientWidth, h = D.stage.clientHeight;
  D.map.width = Math.max(1, Math.round(w * dpr)); D.map.height = Math.max(1, Math.round(h * dpr));
  S.layout = null; S.logos = null; S.baseKey = ''; S.linesKey = -1; S.dirty = true; S.dpr = dpr;
}

function makeLayer(key) {
  var cv = S[key] || (S[key] = document.createElement('canvas'));
  if (cv.width !== D.map.width || cv.height !== D.map.height) { cv.width = D.map.width; cv.height = D.map.height; }
  var c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  c.lineJoin = 'round'; c.lineCap = 'round';
  return c;
}

// Static fills for the committed (start-of-transition) owners; rebuilt only when ownership or layout changes.
// Counties that finish a wipe are painted once into a second layer so no frame re-draws them.
function rebuildBase(L) {
  var c2 = makeLayer('baseCv'), nc = TOPO.counties.length, cTile = M.cTile, owner = S.owner, c;
  S.oc = new Int16Array(nc);
  S.done = new Uint8Array(nc);
  makeLayer('overCv');
  for (c = 0; c < nc; c++) {
    var ti = cTile[c]; if (ti < 0) continue;
    var o = owner[ti]; S.oc[c] = o;
    c2.fillStyle = M.teams[o].color; c2.strokeStyle = M.teams[o].color; c2.lineWidth = 0.6;
    c2.fill(L.cPath[c]); c2.stroke(L.cPath[c]);
  }
}

// one batched path for a set of arcs (cheaper than a stroke per arc)
function traceArc(ctx, flat) {
  var n = flat.length / 2, i;
  ctx.moveTo(flat[0], flat[1]);
  for (i = 1; i < n; i++) ctx.lineTo(flat[i * 2], flat[i * 2 + 1]);
}

function rebuildLines(L) {
  var c2 = makeLayer('linesCv');
  c2.strokeStyle = 'rgba(255,255,255,.55)'; c2.lineWidth = 0.8; c2.stroke(L.stateLines);
  c2.strokeStyle = 'rgba(18,21,28,.28)'; c2.lineWidth = 0.7; c2.stroke(L.coast);
}

var CONUS = [[-124.7, 48.4], [-123, 46], [-124.2, 42], [-122.4, 37.5], [-117.1, 32.5], [-111, 31.3], [-106.5, 31.8], [-104.5, 29.5], [-99.1, 26.4],
  [-97.2, 25.9], [-97.4, 28], [-94, 29.5], [-89, 29], [-84, 30], [-82.8, 27.8], [-81, 25.2], [-80, 26.8], [-81.2, 31.5], [-75.5, 35.2],
  [-76, 37], [-74, 40.5], [-70, 41.7], [-70.7, 43.1], [-67, 44.8], [-69, 47.4], [-83, 46], [-84.5, 46.5], [-88, 48], [-95, 49], [-123, 49]];

function drawSkeleton(ctx, W, H, t) {
  var pL = albers(-96, 37.5, 29.5, 45.5), pts = CONUS.map(function (c) { return pL(c[0], c[1]); }), i;
  var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  pts.forEach(function (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
  var aw = W - 48, ah = H - 224, s = Math.min(aw / (x1 - x0), ah / (y1 - y0));
  var ox = 24 + (aw - (x1 - x0) * s) / 2, oy = 112 + (ah - (y1 - y0) * s) / 2;
  ctx.beginPath();
  for (i = 0; i < pts.length; i++) {
    var x = ox + (pts[i][0] - x0) * s, y = oy + (pts[i][1] - y0) * s;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(18,21,28,' + (0.06 + 0.04 * Math.sin(t / 380)) + ')'; ctx.fill();
}

function focusTeam() {
  if (S.pin >= 0) return S.pin;
  if (S.hoverRow >= 0) return S.hoverRow;
  return S.hoverTeam;
}

// ---------- frame ----------
function draw(t) {
  var ctx = D.ctx, dpr = S.dpr, W = D.map.clientWidth, H = D.map.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!M || !TOPO) { drawSkeleton(ctx, W, H, t); S.dirty = true; return; }
  var L = ensureLayout(); if (!L) { S.dirty = true; return; }
  var focus = focusTeam(), key = S.ownerVersion + '|' + L.id, c, i;
  if (S.baseKey !== key) { rebuildBase(L); S.baseKey = key; }
  if (S.linesKey !== L.id) { rebuildLines(L); S.linesKey = L.id; }
  var oc = S.oc, cTile = M.cTile, over = S.overCv.getContext('2d');

  // counties mid-wipe blend old colour into new with a bright leading edge; finished ones move to the static overlay layer
  if (S.segs) {
    over.lineJoin = 'round';
    for (i = 0; i < S.changed.length; i++) {
      c = S.changed[i];
      if (S.done[c]) continue;
      var sg = S.segs[cTile[c]]; if (!sg) continue;
      var p = (t - sg.start) / sg.dur;
      if (p <= 0) continue;
      if (p >= 1) {
        over.fillStyle = M.teams[sg.to].color; over.strokeStyle = M.teams[sg.to].color; over.lineWidth = 0.6;
        over.fill(L.cPath[c]); over.stroke(L.cPath[c]);
        oc[c] = sg.to; S.done[c] = 1;
      } else oc[c] = p > 0.5 ? sg.to : sg.from;
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(S.baseCv, 0, 0);
  ctx.drawImage(S.overCv, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  if (S.segs) {
    for (i = 0; i < S.changed.length; i++) {
      c = S.changed[i];
      if (S.done[c]) continue;
      var sg2 = S.segs[cTile[c]]; if (!sg2) continue;
      var q = (t - sg2.start) / sg2.dur;
      if (q <= 0 || q >= 1) continue;
      var col = mixRgb(M.teams[sg2.from].rgb, M.teams[sg2.to].rgb, easeInOut(q));
      ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 0.6;
      ctx.fill(L.cPath[c]); ctx.stroke(L.cPath[c]);
      ctx.fillStyle = 'rgba(255,255,255,' + (Math.sin(Math.PI * q) * 0.42) + ')'; ctx.fill(L.cPath[c]);
    }
  }

  // spotlight: fade everything painted so far, then redraw only the focused team's counties
  if (focus >= 0) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(244,242,236,.8)'; ctx.fillRect(0, 0, L.W, L.H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = M.teams[focus].color; ctx.strokeStyle = M.teams[focus].color; ctx.lineWidth = 0.6;
    for (c = 0; c < oc.length; c++) if (cTile[c] >= 0 && oc[c] === focus) { ctx.fill(L.cPath[c]); ctx.stroke(L.cPath[c]); }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(S.linesCv, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // territory borders where neighbouring counties have different owners (one batched stroke)
  var list = L.arcList, sa = L.scrArcs;
  ctx.beginPath();
  for (i = 0; i < list.length; i++) {
    var en = list[i];
    if (en[2] >= 0 && oc[en[1]] !== oc[en[2]] && cTile[en[1]] >= 0 && cTile[en[2]] >= 0) traceArc(ctx, sa[en[0]]);
  }
  ctx.strokeStyle = BG; ctx.lineWidth = 1.9; ctx.stroke();
  if (focus >= 0) {
    ctx.beginPath();
    for (i = 0; i < list.length; i++) {
      var e2 = list[i];
      if (cTile[e2[1]] < 0) continue;
      var a1 = oc[e2[1]] === focus, a2 = e2[2] >= 0 ? oc[e2[2]] === focus : false;
      if (a1 !== a2) traceArc(ctx, sa[e2[0]]);
    }
    ctx.strokeStyle = '#12151c'; ctx.lineWidth = 2.6; ctx.stroke();
  }

  syncLogos(focus);
  S.dirty = false;
}

// ---------- logos: one per connected piece of territory ----------
var LOGO_IMGS = {};
function logoImg(code) {
  var e = LOGO_IMGS[code];
  if (!e) {
    e = LOGO_IMGS[code] = { img: new Image(), ok: false };
    e.img.onload = function () { e.ok = true; S.dirty = true; };
    e.img.src = 'logos/' + code + '.png';
  }
  return e.ok ? e.img : null;
}

// connected components of same-owner counties for a page, each with an interior anchor point and a fitted logo size
function componentsFor(page) {
  var L = ensureLayout(); if (!L) return [];
  if (L.compCache[page]) return L.compCache[page];
  var nc = TOPO.counties.length, ow = M.ownerByPage[page], cTile = M.cTile, c, i;
  var own = new Int16Array(nc), compId = new Int32Array(nc).fill(-1);
  for (c = 0; c < nc; c++) own[c] = cTile[c] >= 0 ? ow[M.tiles[cTile[c]].t] : -1;
  var comps = [];
  for (c = 0; c < nc; c++) {
    if (own[c] < 0 || compId[c] >= 0) continue;
    var id = comps.length, stack = [c], list = [], area = 0, sx = 0, sy = 0;
    compId[c] = id;
    while (stack.length) {
      var cur = stack.pop(); list.push(cur);
      var ar = L.cArea[cur]; area += ar; sx += L.cBx[cur] * ar; sy += L.cBy[cur] * ar;
      var nb = L.cAdj[cur];
      for (i = 0; i < nb.length; i++) if (own[nb[i]] === own[c] && compId[nb[i]] < 0) { compId[nb[i]] = id; stack.push(nb[i]); }
    }
    comps.push({ team: own[c], list: list, area: area, cx: sx / Math.max(1, area), cy: sy / Math.max(1, area), id: id });
  }
  // The logo goes at the roomiest spot of each piece: the county centre furthest from that piece's own boundary
  // (foreign land or coast), nudged toward the area-weighted centroid so long thin shapes don't pick an end.
  // Boundary arcs are bucketed per piece once, then sampled.
  var bnd = comps.map(function () { return []; });
  L.arcList.forEach(function (en) {
    var ia = compId[en[1]], ib = en[2] >= 0 ? compId[en[2]] : -2;
    if (ia === ib) return;
    var fl = L.scrArcs[en[0]];
    [ia, ib].forEach(function (id) {
      if (id < 0) return;
      var tgt = bnd[id], m;
      for (m = 0; m < fl.length; m += 4) tgt.push(fl[m], fl[m + 1]);
    });
  });
  comps.forEach(function (cp) {
    var pts = bnd[cp.id], best = cp.list[0], bm = 0, bs = -1e18;
    cp.list.forEach(function (cc) {
      var x = L.cBx[cc], y = L.cBy[cc], md = 1e18, q, dx, dy, d;
      for (q = 0; q < pts.length; q += 2) { dx = x - pts[q]; dy = y - pts[q + 1]; d = dx * dx + dy * dy; if (d < md) md = d; }
      md = Math.sqrt(md);
      var sc = md - 0.12 * Math.hypot(x - cp.cx, y - cp.cy);
      if (sc > bs) { bs = sc; bm = md; best = cc; }
    });
    cp.x = L.cBx[best]; cp.y = L.cBy[best];
    cp.size = clamp(Math.min(Math.sqrt(cp.area) * 0.62, bm * 2.1), 0, 170);   // radius never exceeds the room to the nearest edge
  });
  // keep sizeable pieces; every living team keeps at least its biggest piece
  var out = [], biggest = {};
  comps.forEach(function (cp) { if (!biggest[cp.team] || cp.area > biggest[cp.team].area) biggest[cp.team] = cp; });
  comps.forEach(function (cp) {
    if (cp.area >= 2400 && cp.size >= 22) out.push({ team: cp.team, x: cp.x, y: cp.y, size: cp.size });
    else if (biggest[cp.team] === cp) out.push({ team: cp.team, x: cp.x, y: cp.y, size: Math.max(cp.size, 18) });   // a living team always keeps a logo, however small its land
  });
  L.compCache[page] = out;
  return out;
}

// ---------- logos: DOM layers moved by transform ----------
// A logo is an element, not canvas pixels. transform and opacity transitions run on the compositor, so a glide
// stays smooth even when the main thread is busy repainting the map mid-sweep (the cause of choppy playback).
var LOGO_BASE = 170, LEAD_MS = 760;

function logoTransform(c) { return 'translate(' + c.x + 'px,' + c.y + 'px) scale(' + (Math.max(c.size, 1) / LOGO_BASE) + ')'; }

function makeLogoNode(team) {
  var tm = M.teams[team], node = el('div', 'lg'), img = new Image();
  img.alt = ''; img.draggable = false;
  img.onerror = function () {                      // crest fallback when the logo file is missing
    if (img.parentNode) img.parentNode.removeChild(img);
    var cr = el('div', 'crest', tm.code); cr.style.borderColor = tm.color; cr.style.color = lum(tm.color) > 0.62 ? '#1a1d24' : tm.color;
    node.appendChild(cr);
  };
  img.src = 'logos/' + tm.code + '.png';
  node.appendChild(img);
  return node;
}

// a thin leader line from a logo that was nudged off its land back to the land it belongs to
function updateLead(lg, delay) {
  var far = Math.hypot(lg.x - lg.ax, lg.y - lg.ay) > lg.size * 0.45;
  clearTimeout(lg.leadT);
  if (!far) { if (lg.lead) lg.lead.classList.remove('on'); return; }
  if (!lg.lead) {
    lg.lead = el('div', 'lead'); lg.lead.appendChild(el('i')); lg.lead.appendChild(el('b'));
    lg.lead.style.setProperty('--c', M.teams[lg.team].color);
    D.logos.insertBefore(lg.lead, D.logos.firstChild);
  }
  var dx = lg.x - lg.ax, dy = lg.y - lg.ay;
  lg.lead.classList.remove('on');
  lg.lead.style.width = Math.hypot(dx, dy) + 'px';
  lg.lead.style.transform = 'translate(' + lg.ax + 'px,' + lg.ay + 'px) rotate(' + Math.atan2(dy, dx) + 'rad)';
  if (delay) lg.leadT = setTimeout(function () { lg.lead.classList.add('on'); }, delay); else lg.lead.classList.add('on');
}

function dropLogo(lg) {
  clearTimeout(lg.leadT);
  lg.node.style.opacity = '0';
  if (lg.lead) lg.lead.classList.remove('on');
  setTimeout(function () {
    if (lg.node.parentNode) lg.node.parentNode.removeChild(lg.node);
    if (lg.lead && lg.lead.parentNode) lg.lead.parentNode.removeChild(lg.lead);
  }, 450);
}

function addLogo(c, grow) {
  var lg = { team: c.team, x: c.x, y: c.y, ax: c.ax, ay: c.ay, size: c.size, node: makeLogoNode(c.team), lead: null, leadT: 0 };
  D.logos.appendChild(lg.node);
  if (grow) {                                      // spawn small and transparent, then grow into place
    lg.node.style.transition = 'none';
    lg.node.style.transform = logoTransform({ x: c.x, y: c.y, size: c.size * 0.3 }); lg.node.style.opacity = '0';
    void lg.node.offsetWidth;
    lg.node.style.transition = '';
  }
  lg.node.style.transform = logoTransform(lg); lg.node.style.opacity = dimFor(lg.team);
  updateLead(lg, grow ? LEAD_MS : 0);
  return lg;
}

function dimFor(team) { var f = S.logoFocus; return (f >= 0 && f !== team) ? '0.3' : '1'; }

function hardSetLogos(page) {
  if (S.logos) S.logos.forEach(function (lg) { dropLogo(lg); });
  D.logos.textContent = '';
  S.logos = componentsFor(page).map(function (c) { return addLogo(c, false); });
}

// glide existing logos to the matching piece of the new territory; spawn new ones, retire the rest
function retargetLogos(page) {
  if (!S.logos) { hardSetLogos(page); return; }
  var targets = componentsFor(page).map(function (c) { return { c: c, used: false }; }), keep = [];
  S.logos.forEach(function (lg) {
    var best = null, bd = 450;
    targets.forEach(function (tg) {
      if (tg.used || tg.c.team !== lg.team) return;
      var d = Math.hypot(tg.c.x - lg.x, tg.c.y - lg.y);
      if (d < bd) { bd = d; best = tg; }
    });
    if (best) {
      best.used = true;
      lg.x = best.c.x; lg.y = best.c.y; lg.ax = best.c.ax; lg.ay = best.c.ay; lg.size = best.c.size;
      lg.node.style.transform = logoTransform(lg);
      updateLead(lg, LEAD_MS);
      keep.push(lg);
    } else dropLogo(lg);
  });
  targets.forEach(function (tg) { if (!tg.used) keep.push(addLogo(tg.c, true)); });
  S.logos = keep;
  S.dirty = true;
}

// dim every logo outside the focused team; called from draw, which already runs whenever focus changes
function syncLogos(focus) {
  if (!S.logos) hardSetLogos(S.page);
  if (S.logoFocus === focus) return;
  S.logoFocus = focus;
  S.logos.forEach(function (lg) {
    var o = dimFor(lg.team);
    lg.node.style.opacity = o;
    if (lg.lead) lg.lead.style.opacity = o === '1' ? '' : '0.3';
  });
}
