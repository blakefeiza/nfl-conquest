'use strict';
// NFL Conquest Map - ui: boot, week transitions (parallel wipes), toasts, standings, HUD, controls.

// ---------- boot ----------
window.onload = function () {
  ['stage', 'map', 'logos', 'weekLabel', 'weekWrap', 'aliveV', 'leadV', 'champ', 'loading', 'msg', 'tip',
    'play', 'playIcon', 'prev', 'next', 'speed', 'scrub', 'fill', 'thumb', 'board', 'boardWrap', 'results',
    'resTitle', 'resSub'].forEach(function (id) { D[id] = $(id); });
  D.ctx = D.map.getContext('2d');
  wireUi();
  resizeCanvas();
  new ResizeObserver(function () { resizeCanvas(); refreshBoxes(); }).observe(D.stage);
  refreshBoxes();
  window.addEventListener('scroll', refreshBoxes, true);
  requestAnimationFrame(frame);

  var topoReady = new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open('GET', 'counties-10m.json');
    x.onload = function () {
      try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new Error('counties-10m.json status ' + x.status + ': ' + describeError(e))); }
    };
    x.onerror = function () { reject(new Error('XHR blocked for counties-10m.json')); };
    x.send();
  }).then(function (t) { TOPO = decodeTopo(t); });
  topoReady.catch(function (err) { showMsg('Could not load county shapes: ' + describeError(err)); });

  tableau.extensions.initializeAsync().then(function () {
    worksheet = tableau.extensions.worksheetContent.worksheet;
    worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, function () { topoReady.then(load); });
    topoReady.then(load);
  }, function (err) { showMsg('Init error: ' + describeError(err)); });
};

function load() {
  worksheet.getSummaryDataAsync({ ignoreSelection: true }).then(function (data) {
    var t0 = now();
    try {
      var m = buildModel(data);
      if (!m) return;
      var firstLoad = !M;
      M = m;
      S.layout = null; S.logos = null;
      initState(firstLoad);
      console.log(TAG + 'rows=' + data.data.length + ' tiles=' + M.nTiles + ' counties=' + TOPO.counties.length + ' teams=' + M.teams.length +
        ' pages=' + (M.maxPage + 1) + ' games=' + M.games.length + ' build=' + Math.round(now() - t0) + 'ms');
    } catch (e) { showMsg('Build error: ' + describeError(e)); }
  }, function (err) { showMsg('Data error: ' + describeError(err)); });
}

function initState(firstLoad) {
  var keep = firstLoad ? 0 : Math.min(S.page, M.maxPage);
  S.page = keep; S.shownPage = -1; S.pendingPage = null;
  S.owner = ownerArray(keep); S.ownerVersion++;
  S.segs = null; S.changed = []; S.tl = null; S.animEnd = 0;
  S.live = new Int32Array(M.countsByPage[keep]);
  S.disp = new Float64Array(M.teams.length);
  S.pin = -1; S.logos = null;
  D.loading.style.display = 'none';
  buildBoard(); buildTicks();
  showPage(keep, true);
  updateBoard(true); updateHud();
  S.dirty = true;
}

function frame() {
  var t = now();
  tickTimeline(t);
  tickNumbers();
  if (S.dirty || S.segs || S.logoMoving) draw(t);
  requestAnimationFrame(frame);
}

// ---------- week transitions ----------
function commit(page) {
  S.owner = ownerArray(page); S.ownerVersion++;
  S.segs = null; S.changed = []; S.tl = null; S.animEnd = 0;
  S.page = page; S.pendingPage = null;
  S.live = new Int32Array(M.countsByPage[page]);
  Array.prototype.forEach.call(D.results.querySelectorAll('.game.active'), function (x) { x.classList.remove('active'); });
  S.dirty = true;
}

function goTo(target, mode) {
  if (!M || !TOPO) return;
  target = clamp(target, 0, M.maxPage);
  if (S.segs) commit(S.pendingPage != null ? S.pendingPage : S.page);
  if (target === S.page) { showPage(target, false); updateBoard(true); updateHud(); return; }
  if (!ensureLayout()) return;
  startTransition(target, mode === 'fast' || target !== S.page + 1);
}

// Every conquest of the week starts together. Each (old owner -> new owner) region wipes left to right
// over its own width, so neighbouring regions of the winner merge into one colour as the front passes.
function startTransition(target, fast) {
  var L = S.layout, tgt = M.ownerByPage[target], groups = {}, i, t0 = now();
  for (i = 0; i < M.nTiles; i++) {
    var no = tgt[M.tiles[i].t];
    if (no !== S.owner[i]) (groups[S.owner[i] + '>' + no] || (groups[S.owner[i] + '>' + no] = [])).push(i);
  }
  var sweep = fast ? speedMs(520) : speedMs(1500), blend = fast ? speedMs(260) : speedMs(420);
  var start = t0 + (fast ? 0 : speedMs(300)), segs = new Array(M.nTiles);
  Object.keys(groups).forEach(function (k) {
    var list = groups[k], parts = k.split('>'), from = +parts[0], to = +parts[1], x0 = 1e9, x1 = -1e9;
    list.forEach(function (ti) { if (L.px[ti] < x0) x0 = L.px[ti]; if (L.px[ti] > x1) x1 = L.px[ti]; });
    var span = Math.max(1, x1 - x0);
    list.forEach(function (ti) { segs[ti] = { from: from, to: to, start: start + ((L.px[ti] - x0) / span) * sweep, dur: blend }; });
  });
  var changed = [], cTile = M.cTile, c;
  for (c = 0; c < cTile.length; c++) if (cTile[c] >= 0 && segs[cTile[c]]) changed.push(c);
  S.segs = segs; S.changed = changed; S.pendingPage = target;
  S.animEnd = Object.keys(groups).length ? start + sweep + blend + speedMs(fast ? 40 : 260) : t0 + speedMs(450);
  S.tl = { start: start, mid: start + sweep * 0.5, target: target, fast: fast, fired: false, midDone: false };
  showPage(target, false);
}

function tickTimeline(t) {
  if (!M) return;
  var tl = S.tl;
  if (tl) {
    if (!tl.fired && t >= tl.start) { tl.fired = true; if (!tl.fast) fireWeek(M.events[tl.target]); }
    if (!tl.midDone && t >= tl.mid) {
      tl.midDone = true;
      S.live = new Int32Array(M.countsByPage[tl.target]);
      updateBoard(tl.fast); updateHud();
      retargetLogos(tl.target);
    }
  }
  if (S.segs && t >= S.animEnd) {
    var page = S.pendingPage != null ? S.pendingPage : S.page;
    commit(page);
    updateBoard(false); updateHud();
    S.holdUntil = t + speedMs(1000);
  }
  if (S.playing && !S.segs && t >= S.holdUntil) {
    if (S.page >= M.maxPage) setPlaying(false);
    else goTo(S.page + 1, 'events');
  }
}

// the only side effect of a week starting: highlight that week's games in the results list
function fireWeek(evs) {
  Array.prototype.forEach.call(D.results.querySelectorAll('.game.active'), function (x) { x.classList.remove('active'); });
  evs.forEach(function (ev) { if (ev.game && ev.game.el) ev.game.el.classList.add('active'); });
}

// scrubber fill/thumb move with transform only (compositor); the track width is cached, never read per event
var BOX = { scrub: null, map: null };
function placeScrub() {
  var w = D.scrub.clientWidth, f = S.frac || 0;
  D.fill.style.transform = 'scaleX(' + f + ')';
  D.thumb.style.transform = 'translateX(' + (f * w) + 'px)';
}
function refreshBoxes() { BOX.scrub = D.scrub.getBoundingClientRect(); BOX.map = D.map.getBoundingClientRect(); placeScrub(); }

// ---------- team badges ----------
function badge(team, cls) {
  var b = el('span', 'badge' + (cls ? ' ' + cls : ''));
  var img = new Image();
  img.className = 'logo'; img.alt = team.code;
  img.onerror = function () {
    if (img.parentNode) img.parentNode.removeChild(img);
    b.textContent = team.code; b.style.background = team.color; b.style.color = ink(team.color); b.classList.add('txt');
  };
  img.src = 'logos/' + team.code + '.png';
  b.appendChild(img);
  return b;
}

// ---------- standings ----------
var RH = 32;
function buildBoard() {
  while (D.board.firstChild) D.board.removeChild(D.board.firstChild);
  D.board.style.height = (M.teams.length * RH) + 'px';
  M.teams.forEach(function (tm, t) {
    var row = el('div', 'row');
    var rk = el('span', 'rk', ''), mid = el('div', 'mid'), nm = el('span', 'nm', tm.name), bar = el('div', 'bar'), pc = el('span', 'pc', '');
    bar.style.background = tm.color; bar.style.transform = 'scaleX(0)';
    mid.appendChild(nm); mid.appendChild(bar);
    row.appendChild(rk); row.appendChild(badge(tm)); row.appendChild(mid); row.appendChild(pc);
    row.style.transform = 'translateY(' + (t * RH) + 'px)';
    row.addEventListener('mouseenter', function () { S.hoverRow = t; S.dirty = true; });
    row.addEventListener('mouseleave', function () { S.hoverRow = -1; S.dirty = true; });
    row.addEventListener('click', function () { S.pin = S.pin === t ? -1 : t; refreshPins(); S.dirty = true; });
    row.setAttribute('tabindex', '0'); row.setAttribute('role', 'button'); row.setAttribute('aria-label', 'Spotlight ' + tm.name);
    row.addEventListener('focus', function () { S.hoverRow = t; S.dirty = true; });
    row.addEventListener('blur', function () { S.hoverRow = -1; S.dirty = true; });
    row.addEventListener('keydown', function (ev) {
      if (ev.code === 'Enter') { ev.preventDefault(); S.pin = S.pin === t ? -1 : t; refreshPins(); S.dirty = true; }
    });
    D.board.appendChild(row);
    tm.row = { el: row, rk: rk, bar: bar, pc: pc };
  });
  S.lastRank = null;
}
function refreshPins() { M.teams.forEach(function (tm, t) { tm.row.el.classList.toggle('pin', S.pin === t); }); }

function rankOrder(counts) {
  var ids = M.teams.map(function (x, i) { return i; });
  ids.sort(function (a, b) {
    var da = counts[a] === 0, db = counts[b] === 0;
    if (da !== db) return da ? 1 : -1;
    if (!da) return counts[b] - counts[a] || M.teams[a].name.localeCompare(M.teams[b].name);
    return (M.elimSeq[b] || 0) - (M.elimSeq[a] || 0);
  });
  return ids;
}

function updateBoard(instant) {
  if (!M || !S.live) return;
  var order = rankOrder(S.live), prev = S.lastRank, top = Math.max(0.05, S.live[order[0]] / M.nTiles);
  order.forEach(function (t, rank) {
    var tm = M.teams[t], r = tm.row, c = S.live[t], dead = c === 0;
    r.el.style.transform = 'translateY(' + (rank * RH) + 'px)';
    r.rk.textContent = dead ? '' : String(rank + 1);
    r.el.classList.toggle('dead', dead);
    r.bar.style.transform = 'scaleX(' + (c / M.nTiles / top) + ')';
    if (prev && prev[t] !== undefined && c > prev[t] && !instant && !reducedMotion()) r.el.animate([{ background: rgba(tm.color, .4) }, { background: rgba(tm.color, 0) }], { duration: 800 });
  });
  var pm = {}; order.forEach(function (t) { pm[t] = S.live[t]; });
  S.lastRank = pm;
}

function tickNumbers() {
  if (!M || !S.live) return;
  M.teams.forEach(function (tm, t) {
    var target = S.live[t] / M.nTiles * 100, d = S.disp[t];
    if (Math.abs(target - d) > 0.02) S.disp[t] = d + (target - d) * 0.2; else if (d !== target) S.disp[t] = target; else return;
    tm.row.pc.textContent = S.live[t] === 0 ? 'no land' : S.disp[t].toFixed(1) + '%';
  });
}

// ---------- HUD ----------
function updateHud() {
  if (!M) return;
  var order = rankOrder(S.live), lead = M.teams[order[0]], alive = 0, i;
  for (i = 0; i < S.live.length; i++) if (S.live[i] > 0) alive++;
  D.aliveV.textContent = '';
  D.aliveV.appendChild(document.createTextNode(String(alive)));
  D.aliveV.appendChild(el('small', null, '/ ' + M.teams.length));
  D.leadV.textContent = '';
  D.leadV.appendChild(document.createTextNode(lead.code));
  D.leadV.appendChild(el('small', null, (S.live[order[0]] / M.nTiles * 100).toFixed(1) + '%'));
  document.documentElement.style.setProperty('--accent', lum(lead.color) > 0.75 ? '#12151c' : lead.color);
  var champ = D.champ;
  if (alive === 1 && S.page === M.maxPage && !S.segs) {
    champ.style.display = 'block'; champ.textContent = lead.name.toUpperCase() + ' CONQUER THE LEAGUE';
    champ.style.background = lead.color; champ.style.color = ink(lead.color);
  } else champ.style.display = 'none';
}

function showPage(p, instant) {
  var frac = M.maxPage ? p / M.maxPage : 0;
  S.frac = frac; placeScrub();
  Array.prototype.forEach.call(D.scrub.querySelectorAll('.tick'), function (tk) { tk.classList.toggle('cur', +tk.getAttribute('data-p') === p); });
  if (S.shownPage === p) return;
  var prev = S.shownPage; S.shownPage = p;
  var w = D.weekLabel;
  if (instant || prev < 0 || reducedMotion()) w.textContent = pageLabel(p);
  else {
    var dir = p > prev ? 1 : -1;
    var o = w.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(' + (-dir * 26) + 'px)', opacity: 0 }], { duration: 160, fill: 'forwards' });
    o.onfinish = function () {
      w.textContent = pageLabel(p);
      w.animate([{ transform: 'translateY(' + (dir * 26) + 'px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'both' });
    };
  }
  buildResults(p);
}

function buildResults(p) {
  var box = D.results; while (box.firstChild) box.removeChild(box.firstChild);
  D.resTitle.textContent = p === 0 ? 'Preseason' : 'Week ' + p + ' results';
  var gs = M.games.filter(function (g) { return g.page === p; }).sort(function (a, b) { return a.slot - b.slot; });
  var moved = 0; gs.forEach(function (g) { if (g.ev) moved += g.ev.n; });
  D.resSub.textContent = gs.length ? gs.length + ' games · ' + moved + ' tiles moved' : '';
  if (!gs.length) { var e = el('div', 'game empty', 'Every team starts with its home territory'); box.appendChild(e); return; }
  // built in one fragment, once per week change (never on a redraw); the entrance staggers and is flattened by reduced motion
  var frag = document.createDocumentFragment(), i = 0;
  gs.forEach(function (g) {
    var W = M.teams[M.tIdx[g.w]], Lz = M.teams[M.tIdx[g.l]];
    if (!W || !Lz) return;
    var row = el('div', 'game in'), stripe = el('span', 'gs'), gt = el('div', 'gt');
    row.style.setProperty('--i', String(Math.min(i++, 14)));
    stripe.style.background = W.color;
    [[W, 'w', g.pw], [Lz, 'l', g.pl]].forEach(function (s) {
      var line = el('div', 'gteam ' + s[1]);
      line.appendChild(badge(s[0])); line.appendChild(el('span', 'cd', s[0].code)); line.appendChild(el('span', 'pt', isFinite(s[2]) ? String(s[2]) : ''));
      gt.appendChild(line);
    });
    row.title = W.name + ' ' + g.pw + ', ' + Lz.name + ' ' + g.pl + (g.ev ? ' (+' + g.ev.n + ' tiles)' : ' (no land changed)');
    row.appendChild(stripe); row.appendChild(gt);
    row.appendChild(el('span', 'mv' + (g.ev ? ' on' : ''), g.ev ? '+' + g.ev.n + ' tiles' : 'no land'));
    row.addEventListener('mouseenter', function () { S.hoverRow = M.tIdx[g.w]; S.dirty = true; });
    row.addEventListener('mouseleave', function () { S.hoverRow = -1; S.dirty = true; });
    frag.appendChild(row); g.el = row;
  });
  box.appendChild(frag);
}

// ---------- scrubber ----------
function buildTicks() {
  Array.prototype.forEach.call(D.scrub.querySelectorAll('.tick'), function (x) { x.parentNode.removeChild(x); });
  var every = M.maxPage > 26 ? 2 : 1, p;
  for (p = 0; p <= M.maxPage; p++) {
    if (p % every && p !== M.maxPage) continue;
    var tk = el('span', 'tick', pageShort(p));
    tk.setAttribute('data-p', String(p)); tk.style.left = (M.maxPage ? p / M.maxPage * 100 : 0) + '%';
    D.scrub.appendChild(tk);
  }
}

// ---------- controls ----------
function setPlaying(on) {
  S.playing = on;
  D.play.classList.toggle('on', on);
  while (D.playIcon.firstChild) D.playIcon.removeChild(D.playIcon.firstChild);
  var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', on ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
  D.playIcon.appendChild(p);
  if (on) S.holdUntil = 0;
}

function togglePlay() {
  if (!M) return;
  if (S.playing) { setPlaying(false); return; }
  if (S.page >= M.maxPage && !S.segs) { goTo(0, 'fast'); S.holdUntil = now() + 1100; }
  setPlaying(true);
}

function wireUi() {
  D.play.addEventListener('click', togglePlay);
  D.prev.addEventListener('click', function () { setPlaying(false); goTo(S.page - 1, 'fast'); });
  D.next.addEventListener('click', function () { setPlaying(false); goTo(S.page + 1, 'events'); });
  D.speed.addEventListener('click', function () {
    var order = [1, 2, 4], i = order.indexOf(S.speed);
    S.speed = order[(i + 1) % order.length]; D.speed.textContent = S.speed + 'x';
  });
  var dragging = false, seekEv = null, seekRaf = 0;
  function seek(ev) {
    var r = BOX.scrub || D.scrub.getBoundingClientRect(), f = clamp((ev.clientX - r.left) / r.width, 0, 1), p = Math.round(f * M.maxPage);
    if (p !== (S.segs && S.pendingPage != null ? S.pendingPage : S.page)) goTo(p, 'fast');
  }
  D.scrub.addEventListener('pointerdown', function (ev) { if (!M) return; BOX.scrub = D.scrub.getBoundingClientRect(); dragging = true; setPlaying(false); D.scrub.setPointerCapture(ev.pointerId); seek(ev); });
  D.scrub.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    seekEv = ev;                                        // coalesce to one seek per frame
    if (!seekRaf) seekRaf = requestAnimationFrame(function () { seekRaf = 0; if (seekEv) seek(seekEv); seekEv = null; });
  });
  D.scrub.addEventListener('pointerup', function () { dragging = false; });
  document.addEventListener('keydown', function (ev) {
    if (!M) return;
    if (ev.code === 'Space') { ev.preventDefault(); togglePlay(); }
    else if (ev.code === 'ArrowRight') { setPlaying(false); goTo(S.page + 1, 'events'); }
    else if (ev.code === 'ArrowLeft') { setPlaying(false); goTo(S.page - 1, 'fast'); }
    else if (ev.code === 'Home') { setPlaying(false); goTo(0, 'fast'); }
    else if (ev.code === 'End') { setPlaying(false); goTo(M.maxPage, 'fast'); }
  });
  D.map.addEventListener('pointermove', function (ev) {
    mapEv = ev;                                         // coalesce to one hit-test per frame
    if (!mapRaf) mapRaf = requestAnimationFrame(function () { mapRaf = 0; if (mapEv) onMapMove(mapEv); mapEv = null; });
  });
  D.map.addEventListener('pointerleave', function () { mapEv = null; S.hoverTeam = -1; hideTip(); S.dirty = true; });
  D.map.addEventListener('click', function () {
    S.pin = (S.hoverTeam >= 0 && S.pin !== S.hoverTeam) ? S.hoverTeam : -1;
    refreshPins(); S.dirty = true;
  });
  setPlaying(false);
}

var mapEv = null, mapRaf = 0, tipTeam = -2, tipTile = -1, tipSize = null, tipOn = false;
function onMapMove(ev) {
  if (!M || !S.layout) return;
  var L = S.layout, r = BOX.map || D.map.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  var cx = Math.floor((x - L.minX) / L.cs), cy = Math.floor((y - L.minY) / L.cs), best = -1, bd = 1e18, a, b, c, j;
  for (b = cy - 2; b <= cy + 2; b++) for (a = cx - 2; a <= cx + 2; a++) {
    if (a < 0 || b < 0 || a >= L.gw || b >= L.gh) continue;
    c = L.grid[b * L.gw + a];
    if (c) for (j = 0; j < c.length; j++) { var dx = L.px[c[j]] - x, dy = L.py[c[j]] - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = c[j]; } }
  }
  if (best < 0 || Math.sqrt(bd) > L.cs * 1.1) { if (S.hoverTeam !== -1) { S.hoverTeam = -1; S.dirty = true; } hideTip(); return; }
  var team = S.owner[best], tm = M.teams[team], tile = M.tiles[best], orig = M.teams[tile.t];
  if (S.hoverTeam !== team) { S.hoverTeam = team; S.dirty = true; }
  var tip = D.tip;
  // rebuild the tooltip DOM only when its content changes; otherwise just move it
  var tkey = team * 100000 + best;
  if (tipTeam !== tkey || tipTile !== S.live[team]) {
    tipTeam = tkey; tipTile = S.live[team];
    tip.textContent = '';
    var tn = el('div', 'tn'); tn.appendChild(badge(tm)); tn.appendChild(document.createTextNode(tm.name)); tip.appendChild(tn);
    tip.appendChild(el('div', 'tr', (tile.state || 'Unknown state') + (tile.grp !== 'L' ? ' (inset)' : '')));
    tip.appendChild(el('div', 'tr', 'Holds ' + S.live[team] + ' tiles (' + (S.live[team] / M.nTiles * 100).toFixed(1) + '%)'));
    if (orig.idx !== team) tip.appendChild(el('div', 'tr', 'Originally ' + orig.name + ' territory'));
    tipSize = null;                                     // shape changed: re-measure once, below
  }
  // hidden with visibility (not display) so it keeps a box to measure; the size is reused until the shape changes
  if (!tipSize) tipSize = { w: tip.offsetWidth, h: tip.offsetHeight };
  var GAP = 14, EDGE = 8, SW = D.stage.clientWidth, SH = D.stage.clientHeight;
  var tx = (x + GAP + tipSize.w > SW - EDGE) ? x - GAP - tipSize.w : x + GAP;
  var ty = clamp(y - tipSize.h / 2, EDGE, SH - tipSize.h - EDGE);
  tx = Math.max(EDGE, tx);
  var tf = 'translate(' + tx + 'px,' + ty + 'px)';
  if (tipOn) tip.style.transform = tf;                  // retarget mid-flight: the card trails the pointer
  else { placeInstantly(tip, tf); tipOn = true; tip.classList.add('on'); }   // first show jumps; it must not glide in from its last spot
}
function hideTip() { tipTeam = -2; tipOn = false; D.tip.classList.remove('on'); }
