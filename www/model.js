// FPL projection model + transfer optimiser. Pure functions; works in browser and node.
(function (G) {
  const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const GOAL = { 1: 10, 2: 6, 3: 5, 4: 4 }, CS = { 1: 4, 2: 4, 3: 1, 4: 0 }, DCT = { 1: 99, 2: 10, 3: 12, 4: 12 };
  const HOME = 1.12, AWAY = 0.89;
  // Calibrated on 2026-27 GW1-10: FPL awards ~35% more assists than xA; xG-Poisson overstates conceding.
  const ASSIST_K = 1.35, CS_K = 0.88;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pmf = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
  const pGE = (t, l) => { let c = 0; for (let k = 0; k < t; k++) c += pmf(k, l); return Math.max(0, 1 - c); };
  const eFloor = (n, l) => { let e = 0; for (let k = n; k < 14; k++) e += Math.floor(k / n) * pmf(k, l); return e; };

  // Normalise either the bundled snapshot or pasted official JSON into one shape.
  function normalise(snap, fresh) {
    const recent = (fresh && fresh.recent) || snap.recent || {};
    let players, fixtures, teams, meta = { ...snap.meta };
    if (fresh && fresh.bootstrap) {
      const b = fresh.bootstrap;
      teams = b.teams.map(t => ({ id: t.id, name: t.name, short: t.short_name }));
      players = b.elements.map(e => ({
        id: e.id, name: e.web_name, team: e.team, pos: e.element_type, cost: e.now_cost / 10, status: e.status,
        chance: e.chance_of_playing_next_round, news: e.news || '', min: e.minutes, starts: e.starts,
        xg: +e.expected_goals, xa: +e.expected_assists, xgc: +e.expected_goals_conceded, saves: e.saves, bonus: e.bonus,
        dc: e.defensive_contribution || 0, yc: e.yellow_cards, pts: e.total_points, form: +e.form, sel: +e.selected_by_percent,
        pen: e.penalties_order, recent: recent[e.id] || null
      }));
      const ev = (b.events || []).filter(e => e.finished || e.data_checked);
      meta = fresh.meta || { source: 'Official FPL data you pasted', snapshot: new Date().toISOString().slice(0, 10), statsThroughGW: ev.length ? Math.max(...ev.map(e => e.id)) : null };
    } else {
      const c = snap.cols, ix = n => c.indexOf(n);
      teams = snap.teams.map(([id, name, short]) => ({ id, name, short }));
      players = snap.players.map(r => ({
        id: r[ix('id')], name: r[ix('web_name')], team: r[ix('team')], pos: r[ix('element_type')], cost: r[ix('now_cost')] / 10,
        status: r[ix('status')], chance: r[ix('chance_of_playing_next_round')], news: r[ix('news')] || '', min: r[ix('minutes')],
        starts: r[ix('starts')], xg: r[ix('expected_goals')], xa: r[ix('expected_assists')], xgc: r[ix('expected_goals_conceded')],
        saves: r[ix('saves')], bonus: r[ix('bonus')], dc: r[ix('defensive_contribution')] || 0, yc: r[ix('yellow_cards')],
        pts: r[ix('total_points')], form: +r[ix('form')], sel: +r[ix('selected_by_percent')], pen: r[ix('penalties_order')],
        recent: recent[r[ix('id')]] || null
      }));
    }
    if (fresh && fresh.fixtures) {
      fixtures = fresh.fixtures.map(f => ({ id: f.id, ev: f.event, ko: f.kickoff_time, h: f.team_h, a: f.team_a, fin: f.finished, hs: f.team_h_score, as: f.team_a_score }));
    } else {
      fixtures = snap.fixtures.map(([id, ev, ko, h, a, fin, hs, as]) => ({ id, ev, ko, h, a, fin, hs, as }));
    }
    return { players, fixtures, teams, meta };
  }

  function build(snap, opt = {}) {
    const D = normalise(snap, opt.fresh);
    const now = opt.now ? new Date(opt.now) : new Date();
    const override = opt.minutes || {};
    const tIds = D.teams.map(t => t.id);
    // games played per team (finished fixtures)
    const gp = {}; tIds.forEach(t => gp[t] = 0);
    D.fixtures.forEach(f => { if (f.fin) { gp[f.h]++; gp[f.a]++; } });
    // next gameweek = first GW whose earliest kickoff is still in the future
    const firstKo = {};
    D.fixtures.forEach(f => { if (f.ev && f.ko) { const t = Date.parse(f.ko); if (!(f.ev in firstKo) || t < firstKo[f.ev]) firstKo[f.ev] = t; } });
    const gws = Object.keys(firstKo).map(Number).sort((a, b) => a - b);
    const nextGW = opt.nextGW || gws.find(g => firstKo[g] > now.getTime()) || gws[gws.length - 1];
    // team strength from player xG sums and keeper xGC
    const att = {}, def = {}, gkMin = {}, gkXgc = {};
    tIds.forEach(t => { att[t] = 0; gkMin[t] = 0; gkXgc[t] = 0; });
    D.players.forEach(p => { att[p.team] += p.xg || 0; if (p.pos === 1) { gkMin[p.team] += p.min; gkXgc[p.team] += p.xgc || 0; } });
    tIds.forEach(t => { att[t] = gp[t] ? att[t] / gp[t] : 0; def[t] = gkMin[t] ? gkXgc[t] / (gkMin[t] / 90) : 0; });
    const mu = tIds.reduce((s, t) => s + att[t], 0) / tIds.length || 1.35;
    const K = 4; // games of prior toward league average
    tIds.forEach(t => { att[t] = (att[t] * gp[t] + mu * K) / (gp[t] + K); def[t] = (def[t] * gp[t] + mu * K) / (gp[t] + K); });

    // position priors (per-90) for shrinkage
    const prior = {};
    [1, 2, 3, 4].forEach(ps => {
      const reg = D.players.filter(p => p.pos === ps && p.min >= 450);
      const m = reg.reduce((s, p) => s + p.min, 0) || 1, f = k => reg.reduce((s, p) => s + (p[k] || 0), 0) / m * 90 * 0.7;
      prior[ps] = { xg: f('xg'), xa: f('xa'), bonus: f('bonus'), dc: f('dc'), saves: f('saves'), yc: f('yc') };
    });
    const rate = (p, k, Kmin) => ((p[k] || 0) + prior[p.pos][k] * Kmin / 90) / (p.min + Kmin) * 90;

    // fixtures per team per GW
    const byTeam = {}; tIds.forEach(t => byTeam[t] = {});
    D.fixtures.forEach(f => { if (!f.ev || f.ev < nextGW) return; (byTeam[f.h][f.ev] ||= []).push({ opp: f.a, home: true }); (byTeam[f.a][f.ev] ||= []).push({ opp: f.h, home: false }); });
    const horizonGWs = gws.filter(g => g >= nextGW);

    const W = [0.5, 0.6, 0.7, 0.8, 0.9, 1];
    D.players.forEach(p => {
      p.posName = POS[p.pos];
      const seasonM = gp[p.team] ? clamp(p.min / gp[p.team], 0, 90) : 0;
      let rm = null;
      if (p.recent) { let s = 0, w = 0; p.recent.forEach((m, i) => { if (m != null) { s += Math.min(90, m) * W[i + W.length - p.recent.length]; w += W[i + W.length - p.recent.length]; } }); if (w) rm = s / w; }
      p.baseMin = override[p.id] != null ? +override[p.id] : rm == null ? seasonM : 0.65 * rm + 0.35 * seasonM;
      p.overridden = override[p.id] != null;
      const per90min = 270;
      p.xg90 = rate(p, 'xg', per90min); p.xa90 = rate(p, 'xa', per90min);
      p.shareG = att[p.team] ? p.xg90 / att[p.team] : 0; p.shareA = att[p.team] ? p.xa90 / att[p.team] : 0;
      p.bonus90 = rate(p, 'bonus', 450); p.dc90 = rate(p, 'dc', 270); p.sv90 = rate(p, 'saves', 270); p.yc90 = rate(p, 'yc', 450);
      p.ep = {}; p.detail = {};
      horizonGWs.forEach((g, k) => {
        const av = avail(p, k);
        let tot = 0; const parts = [];
        (byTeam[p.team][g] || []).forEach(fx => {
          const lf = mu * (att[p.team] / mu) * (def[fx.opp] / mu) * (fx.home ? HOME : AWAY);
          const la = mu * (att[fx.opp] / mu) * (def[p.team] / mu) * (fx.home ? AWAY : HOME);
          const M = p.baseMin * av;
          const r = fixturePts(p, M, lf, la, def[p.team], mu);
          tot += r.total; parts.push({ ...r, opp: fx.opp, home: fx.home, lf, la, M });
        });
        p.ep[g] = tot; p.detail[g] = parts;
      });
    });
    // fixture difficulty per team per GW for the ticker (expected goals for / against)
    const ticker = {};
    tIds.forEach(t => { ticker[t] = {}; horizonGWs.forEach(g => { ticker[t][g] = (byTeam[t][g] || []).map(fx => ({ opp: fx.opp, home: fx.home, lf: mu * att[t] / mu * def[fx.opp] / mu * (fx.home ? HOME : AWAY), la: mu * att[fx.opp] / mu * def[t] / mu * (fx.home ? AWAY : HOME) })); }); });
    const teamById = {}; D.teams.forEach(t => teamById[t.id] = t);
    const byId = {}; D.players.forEach(p => byId[p.id] = p);
    return { ...D, byId, teamById, nextGW, horizonGWs, att, def, mu, ticker, firstKo };
  }

  function avail(p, k) {
    const st = p.status;
    if (st === 'u' || st === 'n') return 0;
    const c = p.chance == null ? (st === 'a' ? 1 : st === 'd' ? 0.5 : 0) : p.chance / 100;
    if (st === 's') return k === 0 ? c : 1;
    if (c >= 1) return 1;
    return c + (1 - c) * Math.min(1, k * 0.4);
  }

  function fixturePts(p, M, lf, la, teamDef, mu) {
    if (M <= 0) return { total: 0, app: 0, g: 0, a: 0, cs: 0, gc: 0, sv: 0, dc: 0, bonus: 0, yc: 0 };
    const p60 = clamp((M - 15) / 70, 0, 0.95), pPlay = Math.max(p60, clamp(M / 30, 0, 0.99));
    const f = M / 90;
    const app = 2 * p60 + (pPlay - p60);
    const g = p.shareG * lf * f * GOAL[p.pos];
    const a = p.shareA * lf * f * 3 * ASSIST_K;
    const cs = p60 * Math.exp(-la * CS_K) * CS[p.pos];
    const gc = p.pos <= 2 ? -eFloor(2, la * CS_K * f) : 0;
    const sv = p.pos === 1 ? eFloor(3, p.sv90 * (la / teamDef) * f) : 0;
    const dc = p.pos > 1 ? 2 * pGE(DCT[p.pos], p.dc90 * f) : 0;
    const bf = p.pos >= 3 ? Math.sqrt(lf / mu) : Math.sqrt(Math.exp(-la) / Math.exp(-mu));
    const bonus = p.bonus90 * f * bf;
    const yc = -p.yc90 * f;
    return { total: app + g + a + cs + gc + sv + dc + bonus + yc, app, g, a, cs, gc, sv, dc, bonus, yc };
  }

  // Best XI for one GW: 1 GK, >=3 DEF, >=2 MID, >=1 FWD, 11 players.
  function bestXI(squad, g) {
    const by = { 1: [], 2: [], 3: [], 4: [] };
    squad.forEach(p => by[p.pos].push(p));
    Object.values(by).forEach(a => a.sort((x, y) => (y.ep[g] || 0) - (x.ep[g] || 0)));
    const xi = [by[1][0], ...by[2].slice(0, 3), ...by[3].slice(0, 2), by[4][0]].filter(Boolean);
    const rest = [...by[2].slice(3), ...by[3].slice(2), ...by[4].slice(1)].sort((x, y) => (y.ep[g] || 0) - (x.ep[g] || 0));
    xi.push(...rest.slice(0, 11 - xi.length));
    const inXI = new Set(xi); const bench = squad.filter(p => !inXI.has(p)).sort((x, y) => x.pos === 1 ? -1 : y.pos === 1 ? 1 : (y.ep[g] || 0) - (x.ep[g] || 0));
    const cap = xi.reduce((b, p) => (p.ep[g] || 0) > (b.ep[g] || 0) ? p : b, xi[0]);
    const vice = xi.filter(p => p !== cap).reduce((b, p) => !b || (p.ep[g] || 0) > (b.ep[g] || 0) ? p : b, null);
    const pts = xi.reduce((s, p) => s + (p.ep[g] || 0), 0) + (cap ? cap.ep[g] || 0 : 0);
    const benchPts = bench.filter(p => p.pos !== 1).reduce((s, p) => s + (p.ep[g] || 0), 0);
    return { xi, bench, cap, vice, pts, benchPts };
  }

  function squadValue(squad, gwList, disc) {
    let v = 0, first = 0;
    gwList.forEach((g, k) => { const r = bestXI(squad, g); const s = r.pts + 0.1 * r.benchPts; v += Math.pow(disc, k) * s; if (k === 0) first = r.pts; });
    return { v, first };
  }

  const horizonEP = (p, gwList, disc) => gwList.reduce((s, g, k) => s + Math.pow(disc, k) * (p.ep[g] || 0), 0);

  // Search 0/1/2-transfer plans. squadIds: 15 ids, bank in £m, ft free transfers.
  function plan(M, squadIds, bank, ft, o = {}) {
    const H = o.horizon || 6, disc = o.discount ?? 0.85, ftVal = o.ftValue ?? 1.2;
    const gwList = M.horizonGWs.slice(0, H);
    const squad = squadIds.map(id => M.byId[id]).filter(Boolean);
    const base = squadValue(squad, gwList, disc);
    const owned = new Set(squadIds);
    const clubCount = {}; squad.forEach(p => clubCount[p.team] = (clubCount[p.team] || 0) + 1);
    const hz = p => horizonEP(p, gwList, disc);
    const pool = M.players.filter(p => !owned.has(p.id) && p.status !== 'u' && p.status !== 'n');
    // candidate ins per position: top 25 by horizon EP + price-efficient frontier
    const cands = {};
    [1, 2, 3, 4].forEach(ps => {
      const arr = pool.filter(p => p.pos === ps).map(p => ({ p, h: hz(p) })).sort((a, b) => b.h - a.h);
      const top = arr.slice(0, 25);
      const byPrice = [...arr].sort((a, b) => a.p.cost - b.p.cost); let best = -1; const fr = [];
      byPrice.forEach(x => { if (x.h > best + 0.05) { fr.push(x); best = x.h; } });
      const seen = new Set(); cands[ps] = [...top, ...fr].filter(x => !seen.has(x.p.id) && seen.add(x.p.id)).map(x => x.p);
    });
    const ok = (outs, ins) => {
      const money = bank + outs.reduce((s, p) => s + p.cost, 0) - ins.reduce((s, p) => s + p.cost, 0);
      if (money < -1e-9) return null;
      const cc = { ...clubCount }; outs.forEach(p => cc[p.team]--); for (const p of ins) { cc[p.team] = (cc[p.team] || 0) + 1; if (cc[p.team] > 3) return null; }
      return money;
    };
    const evalMove = (outs, ins) => {
      const money = ok(outs, ins); if (money == null) return null;
      const outSet = new Set(outs.map(p => p.id));
      const ns = squad.filter(p => !outSet.has(p.id)).concat(ins);
      const r = squadValue(ns, gwList, disc);
      const n = outs.length, hits = Math.max(0, n - ft) * 4, nextFT = Math.min(5, Math.max(ft - n, 0) + 1);
      return { outs, ins, money, gain: r.v - base.v, gainNow: r.first - base.first, hits, nextFT, net: r.v - base.v - hits + ftVal * (nextFT - Math.min(5, ft + 1)), squadIds: ns.map(p => p.id) };
    };
    const singles = [];
    squad.forEach(o1 => cands[o1.pos].forEach(i1 => { const r = evalMove([o1], [i1]); if (r) singles.push(r); }));
    singles.sort((a, b) => b.net - a.net);
    const doubles = [];
    if (o.doubles !== false) {
      for (let i = 0; i < squad.length; i++) for (let j = i + 1; j < squad.length; j++) {
        const o1 = squad[i], o2 = squad[j];
        const c1 = cands[o1.pos].slice(0, 30), c2 = cands[o2.pos].slice(0, 30);
        c1.forEach(i1 => c2.forEach(i2 => { if (i1.id === i2.id) return; const r = evalMove([o1, o2], [i1, i2]); if (r && r.gain > 0) doubles.push(r); }));
      }
      doubles.sort((a, b) => b.net - a.net);
    }
    // de-duplicate doubles that are just a top single + filler
    const roll = { outs: [], ins: [], money: bank, gain: 0, gainNow: 0, hits: 0, nextFT: Math.min(5, ft + 1), net: 0, squadIds };
    const options = [roll, ...singles.slice(0, 1), ...doubles.slice(0, 1)].sort((a, b) => b.net - a.net);
    return { base, gwList, singles: singles.slice(0, 40), doubles: dedupe(doubles).slice(0, 15), best: options[0], roll, horizonEP: hz };
  }
  function dedupe(arr) { const seen = new Set(); return arr.filter(r => { const k = r.ins.map(p => p.id).sort().join('-'); if (seen.has(k)) return false; seen.add(k); return true; }); }

  // Best 15-man squad under a budget (Wildcard / Free Hit). Hill-climbing with single and paired swaps.
  function optimiseSquad(M, budget, gwList, disc, startIds) {
    const hz = p => horizonEP(p, gwList, disc);
    const lim = { 1: 2, 2: 5, 3: 5, 4: 3 };
    const pool = {};
    [1, 2, 3, 4].forEach(ps => {
      const arr = M.players.filter(p => p.pos === ps && p.status !== 'u' && p.status !== 'n').map(p => ({ p, h: hz(p) }));
      const top = [...arr].sort((a, b) => b.h - a.h).slice(0, 40);
      const cheap = [...arr].sort((a, b) => a.p.cost - b.p.cost || b.h - a.h).slice(0, 8); // bench fodder
      const byPrice = [...arr].sort((a, b) => a.p.cost - b.p.cost); let best = -1; const fr = [];
      byPrice.forEach(x => { if (x.h > best + 0.05) { fr.push(x); best = x.h; } });
      const seen = new Set(); pool[ps] = [...top, ...fr, ...cheap].filter(x => !seen.has(x.p.id) && seen.add(x.p.id)).map(x => x.p);
    });
    const val = sq => squadValue(sq, gwList, disc).v;
    const cost = sq => sq.reduce((s, p) => s + p.cost, 0);
    const clubsOk = sq => { const c = {}; for (const p of sq) { c[p.team] = (c[p.team] || 0) + 1; if (c[p.team] > 3) return false; } return true; };
    // start: cheapest legal squad
    let sq = [];
    [1, 2, 3, 4].forEach(ps => { const c = [...pool[ps]].sort((a, b) => a.cost - b.cost || hz(b) - hz(a)); for (const p of c) { if (sq.filter(x => x.pos === ps).length >= lim[ps]) break; if (clubsOk([...sq, p])) sq.push(p); } });
    if (startIds && startIds.length === 15) { const st = startIds.map(id => M.byId[id]); if (cost(st) <= budget + 1e-9 && clubsOk(st)) { [1, 2, 3, 4].forEach(ps => st.filter(p => p.pos === ps && !pool[ps].includes(p)).forEach(p => pool[ps].push(p))); sq = st; } }
    let cur = val(sq), improved = true, rounds = 0;
    while (improved && rounds++ < 60) {
      improved = false;
      const ids = new Set(sq.map(p => p.id)); let bestMove = null, bestV = cur + 1e-6;
      const money = budget - cost(sq);
      sq.forEach((o, i) => pool[o.pos].forEach(n => {
        if (ids.has(n.id) || n.cost - o.cost > money + 1e-9) return;
        const t = sq.slice(); t[i] = n; if (!clubsOk(t)) return; const v = val(t); if (v > bestV) { bestV = v; bestMove = t; }
      }));
      if (!bestMove) { // paired swaps to escape budget locks (top candidates only)
        for (let i = 0; i < 15 && !bestMove; i++) for (let j = i + 1; j < 15; j++) {
          const a = sq[i], b = sq[j], ca = pool[a.pos].slice(0, 18), cb = pool[b.pos].slice(0, 18);
          for (const x of ca) for (const y of cb) {
            if (x.id === y.id || ids.has(x.id) || ids.has(y.id)) continue;
            if (x.cost + y.cost - a.cost - b.cost > money + 1e-9) continue;
            const t = sq.slice(); t[i] = x; t[j] = y; if (!clubsOk(t)) continue; const v = val(t); if (v > bestV) { bestV = v; bestMove = t; }
          }
        }
      }
      if (bestMove) { sq = bestMove; cur = bestV; improved = true; }
    }
    return { squad: sq, ids: sq.map(p => p.id), cost: cost(sq), value: cur };
  }

  // Per-GW projected points (best XI + captain) for a sequence of squads.
  function timeline(squadsByGW, gwList) { return gwList.map((g, k) => bestXI(squadsByGW[k], g).pts); }

  // Compare strategies over the horizon. chips: {wc:bool, fh:bool}
  function strategies(M, squadIds, bank, ft, o = {}) {
    const H = o.horizon || 5, disc = o.discount ?? 0.85, gwList = M.horizonGWs.slice(0, H);
    const P = plan(M, squadIds, bank, ft, { horizon: H, discount: disc });
    const base = squadIds.map(id => M.byId[id]);
    const budget = bank + base.reduce((s, p) => s + p.cost, 0);
    const out = [];
    const mk = (key, name, moves, squads, hit, extra = {}) => {
      const pts = timeline(squads, gwList); if (hit) pts[0] -= hit;
      out.push({ key, name, moves, pts, total: pts.reduce((a, b) => a + b, 0), hit, squadsIds: squads.map(s => s.map(p => p.id)), ...extra });
    };
    const rep = n => gwList.map(() => n);
    mk('roll', 'Keep the team', [], rep(base), 0, { note: `Roll the transfer: ${Math.min(5, ft + 1)} free next week.` });
    const used = new Set();
    P.singles.filter(m => { const k = m.ins[0].id; if (used.has(k)) return false; used.add(k); return true; }).slice(0, 2).forEach((m, i) => {
      const sq = m.squadIds.map(id => M.byId[id]);
      mk('t' + i, `Transfer ${i === 0 ? 'option A' : 'option B'}`, m.outs.map((p, j) => ({ out: p, in: m.ins[j] })), rep(sq), m.hits, { money: m.money, plan: m });
    });
    if (P.doubles[0]) { const m = P.doubles[0], sq = m.squadIds.map(id => M.byId[id]); mk('d', 'Two transfers', m.outs.map((p, j) => ({ out: p, in: m.ins[j] })), rep(sq), m.hits, { money: m.money, plan: m }); }
    if (o.chips?.fh) {
      const best2 = (gl, d) => { const a = optimiseSquad(M, budget, gl, d), b = optimiseSquad(M, budget, gl, d, squadIds); return a.value >= b.value ? a : b; };
      const fh = best2([gwList[0]], 1);
      mk('fh', 'Free Hit', [], [fh.squad, ...gwList.slice(1).map(() => base)], 0, { chip: true, chipSquad: fh.ids, note: 'One-week squad, then your team returns.' });
    }
    if (o.chips?.wc) {
      const best2 = (gl, d) => { const a = optimiseSquad(M, budget, gl, d), b = optimiseSquad(M, budget, gl, d, squadIds); return a.value >= b.value ? a : b; };
      const wc = best2(gwList, disc);
      mk('wc', 'Wildcard', [], rep(wc.squad), 0, { chip: true, chipSquad: wc.ids, money: budget - wc.cost, note: 'New permanent squad.' });
    }
    const roll = out[0];
    out.forEach(s => { s.delta = s.total - roll.total; s.deltaNow = s.pts[0] - roll.pts[0]; });
    return { gwList, list: out, budget, plan: P };
  }

  G.FPLModel = { build, plan, bestXI, horizonEP, POS, avail, optimiseSquad, strategies };
})(typeof window !== 'undefined' ? window : globalThis);
