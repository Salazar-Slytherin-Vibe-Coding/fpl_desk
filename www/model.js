// FPL projection model + transfer optimiser. Pure functions; works in browser and node.
(function (G) {
  const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const GOAL = { 1: 10, 2: 6, 3: 5, 4: 4 }, CS = { 1: 4, 2: 4, 3: 1, 4: 0 }, DCT = { 1: 99, 2: 10, 3: 12, 4: 12 };
  const HOME = 1.12, AWAY = 0.89;
  // Calibrated on 2026-27 GW1-10: FPL awards ~35% more assists than xA; xG-Poisson overstates conceding.
  const ASSIST_K = 1.35, CS_K = 0.88;
  let DEFAULT_FORM_XG = 0.4, DEFAULT_FORM_PTS = 0, DEFAULT_FINISH = 0;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pmf = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
  const pGE = (t, l) => { let c = 0; for (let k = 0; k < t; k++) c += pmf(k, l); return Math.max(0, 1 - c); };
  const eFloor = (n, l) => { let e = 0; for (let k = n; k < 14; k++) e += Math.floor(k / n) * pmf(k, l); return e; };

  // Normalise either the bundled snapshot or pasted official JSON into one shape.
  function normalise(snap, fresh) {
    const src = fresh && fresh.recent ? fresh : snap, recent = src.recent || {}, rXG = src.recentXG || {}, rXA = src.recentXA || {}, rPts = src.recentPts || {};
    let players, fixtures, teams, meta = { ...snap.meta };
    if (fresh && fresh.bootstrap) {
      const b = fresh.bootstrap;
      teams = b.teams.map(t => ({ id: t.id, name: t.name, short: t.short_name }));
      players = b.elements.map(e => ({
        id: e.id, name: e.web_name, team: e.team, pos: e.element_type, cost: e.now_cost / 10, status: e.status,
        chance: e.chance_of_playing_next_round, news: e.news || '', min: e.minutes, starts: e.starts,
        xg: +e.expected_goals, xa: +e.expected_assists, xgc: +e.expected_goals_conceded, saves: e.saves, bonus: e.bonus,
        dc: e.defensive_contribution || 0, yc: e.yellow_cards, pts: e.total_points, form: +e.form, sel: +e.selected_by_percent,
        gs: e.goals_scored || 0, ast: e.assists || 0, pen: e.penalties_order, recent: recent[e.id] || null, rxg: rXG[e.id] || null, rxa: rXA[e.id] || null, rpts: rPts[e.id] || null
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
        pts: r[ix('total_points')], form: +r[ix('form')], sel: +r[ix('selected_by_percent')], pen: r[ix('penalties_order')], gs: r[ix('goals_scored')] || 0, ast: r[ix('assists')] || 0,
        recent: recent[r[ix('id')]] || null, rxg: rXG[r[ix('id')]] || null, rxa: rXA[r[ix('id')]] || null, rpts: rPts[r[ix('id')]] || null
      }));
    }
    if (fresh && fresh.fixtures) {
      fixtures = fresh.fixtures.map(f => ({ id: f.id, ev: f.event, ko: f.kickoff_time, h: f.team_h, a: f.team_a, fin: f.finished, hs: f.team_h_score, as: f.team_a_score }));
    } else {
      fixtures = snap.fixtures.map(([id, ev, ko, h, a, fin, hs, as]) => ({ id, ev, ko, h, a, fin, hs, as }));
    }
    const hist = (fresh && fresh.hist) || (fresh && fresh.bootstrap ? null : snap.hist) || null;
    return { players, fixtures, teams, meta, hist };
  }

  function build(snap, opt = {}) {
    const FORM_XG = opt.formXG ?? DEFAULT_FORM_XG, FORM_PTS = opt.formPts ?? DEFAULT_FORM_PTS, FINISH = opt.finish ?? DEFAULT_FINISH;
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
      p.minRecent = rm; p.minSeason = seasonM;
      p.baseMin = override[p.id] != null ? +override[p.id] : rm == null ? seasonM : 0.65 * rm + 0.35 * seasonM;
      p.overridden = override[p.id] != null;
      const per90min = 270;
      p.xg90s = rate(p, 'xg', per90min); p.xa90s = rate(p, 'xa', per90min);
      // recent form: recency-weighted xG/xA/points per 90 over the last 6 GWs, shrunk toward the season rate
      let wm = 0, wx = 0, wa = 0, wp = 0;
      if (p.recent) p.recent.forEach((m, i) => { if (m == null) return; const w = W[i + W.length - p.recent.length]; wm += w * m; wx += w * ((p.rxg && p.rxg[i]) || 0); wa += w * ((p.rxa && p.rxa[i]) || 0); wp += w * ((p.rpts && p.rpts[i]) || 0); });
      const KF = 270;
      p.xg90r = p.rxg ? (wx + p.xg90s * KF / 90) / (wm + KF) * 90 : p.xg90s;
      p.xa90r = p.rxa ? (wa + p.xa90s * KF / 90) / (wm + KF) * 90 : p.xa90s;
      p.recentMin90 = wm; p.pts90r = wm > 0 && p.rpts ? wp / wm * 90 : null;
      p.xg90 = (1 - FORM_XG) * p.xg90s + FORM_XG * p.xg90r; p.xa90 = (1 - FORM_XG) * p.xa90s + FORM_XG * p.xa90r;
      // finishing: blend in actual goals/assists per 90 (shrunk to xG) — elite finishers beat xG persistently
      const KG = 450, g90 = (p.gs + p.xg90 * KG / 90) / (p.min + KG) * 90, a90 = (p.ast / ASSIST_K + p.xa90 * KG / 90) / (p.min + KG) * 90;
      p.g90 = g90; p.a90 = a90 * ASSIST_K;
      p.xg90 = (1 - FINISH) * p.xg90 + FINISH * g90; p.xa90 = (1 - FINISH) * p.xa90 + FINISH * a90;
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
        if (FORM_PTS && p.pts90r != null && tot > 0) { // blend toward recent points per 90 (shrunk)
          const M0 = parts.reduce((a, x) => a + x.M, 0), raw = tot / Math.max(1, M0) * 90;
          const sh = (p.pts90r * p.recentMin90 + raw * 270) / (p.recentMin90 + 270);
          const adj = (1 - FORM_PTS) * tot + FORM_PTS * sh * M0 / 90; parts.forEach(x => x.formAdj = (adj - tot) * x.total / tot); tot = adj;
        }
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
    const xG = p.shareG * lf * f, xA = p.shareA * lf * f * ASSIST_K, pcs = Math.exp(-la * CS_K), pdc = p.pos > 1 ? pGE(DCT[p.pos], p.dc90 * f) : 0;
    return { total: app + g + a + cs + gc + sv + dc + bonus + yc, app, g, a, cs, gc, sv, dc, bonus, yc, xG, xA, pcs, pdc, p60, pPlay, dcMean: p.dc90 * f, svMean: p.pos === 1 ? p.sv90 * (la / teamDef) * f : 0 };
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

  // Best 15-man squad under a budget (Wildcard / Free Hit).
  // Objective: best XI + captain each GW, a small weight on bench points, and a tiny cost tie-break so
  // unused money stays in the bank rather than buying expensive bench players.
  function optimiseSquad(M, budget, gwList, disc, startIds, o = {}) {
    const benchW = o.benchW ?? 0.08, costW = o.costW ?? 0.002, lim = { 1: 2, 2: 5, 3: 5, 4: 3 };
    const hz = p => horizonEP(p, gwList, disc);
    const ok = p => p.status !== 'u' && p.status !== 'n';
    const pool = {}, cheap = {};
    [1, 2, 3, 4].forEach(ps => {
      const arr = M.players.filter(p => p.pos === ps && ok(p)).map(p => ({ p, h: hz(p) }));
      const top = [...arr].sort((a, b) => b.h - a.h).slice(0, 45);
      const byPrice = [...arr].sort((a, b) => a.p.cost - b.p.cost || b.h - a.h); let best = -1; const fr = [];
      byPrice.forEach(x => { if (x.h > best + 0.05) { fr.push(x); best = x.h; } });
      cheap[ps] = byPrice.slice(0, 12).map(x => x.p);
      const seen = new Set(); pool[ps] = [...top, ...fr, ...byPrice.slice(0, 12)].filter(x => !seen.has(x.p.id) && seen.add(x.p.id)).map(x => x.p);
    });
    const cost = sq => sq.reduce((s, p) => s + p.cost, 0);
    const val = sq => { let v = 0; gwList.forEach((g, k) => { const r = bestXI(sq, g); v += Math.pow(disc, k) * (r.pts + benchW * r.benchPts); }); return v - costW * cost(sq); };
    const clubsOk = sq => { const c = {}; for (const p of sq) { c[p.team] = (c[p.team] || 0) + 1; if (c[p.team] > 3) return false; } return true; };
    const climb = start => {
      let sq = start.slice(), cur = val(sq), rounds = 0;
      while (rounds++ < 80) {
        const ids = new Set(sq.map(p => p.id)), money = budget - cost(sq);
        let bestMove = null, bestV = cur + 1e-6;
        const tryT = t => { if (!clubsOk(t)) return; const v = val(t); if (v > bestV) { bestV = v; bestMove = t; } };
        // 1) single swaps
        sq.forEach((o, i) => pool[o.pos].forEach(n => { if (ids.has(n.id) || n.cost - o.cost > money + 1e-9) return; const t = sq.slice(); t[i] = n; tryT(t); }));
        // 2) sell-two/buy-two, including downgrading a bench player to fund an XI upgrade
        if (!bestMove) {
          const benchIdx = new Set(); gwList.slice(0, 1).forEach(g => bestXI(sq, g).bench.forEach(p => benchIdx.add(sq.indexOf(p))));
          for (let i = 0; i < 15; i++) for (let j = i + 1; j < 15; j++) {
            const a = sq[i], b = sq[j];
            const ca = benchIdx.has(i) ? [...cheap[a.pos], ...pool[a.pos].slice(0, 15)] : pool[a.pos].slice(0, 22);
            const cb = benchIdx.has(j) ? [...cheap[b.pos], ...pool[b.pos].slice(0, 15)] : pool[b.pos].slice(0, 22);
            for (const x of ca) { if (ids.has(x.id)) continue; for (const y of cb) {
              if (x.id === y.id || ids.has(y.id) || x.cost + y.cost - a.cost - b.cost > money + 1e-9) continue;
              const t = sq.slice(); t[i] = x; t[j] = y; tryT(t);
            } }
          }
        }
        if (!bestMove) break;
        sq = bestMove; cur = bestV;
      }
      return { sq, cur };
    };
    const starts = [];
    { // cheapest legal squad
      const sq = []; [1, 2, 3, 4].forEach(ps => { for (const p of cheap[ps]) { if (sq.filter(x => x.pos === ps).length >= lim[ps]) break; if (clubsOk([...sq, p])) sq.push(p); } }); starts.push(sq);
    }
    if (startIds && startIds.length === 15) { const st = startIds.map(id => M.byId[id]).filter(Boolean); if (st.length === 15 && cost(st) <= budget + 1e-9 && clubsOk(st)) { st.forEach(p => { if (!pool[p.pos].includes(p)) pool[p.pos].push(p); }); starts.push(st); } }
    let best = null; starts.forEach(st => { const r = climb(st); if (!best || r.cur > best.cur) best = r; });
    const sq = best.sq;
    return { squad: sq, ids: sq.map(p => p.id), cost: cost(sq), value: best.cur + costW * cost(sq) };
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
      const fh = optimiseSquad(M, budget, [gwList[0]], 1, squadIds, { benchW: 0.005, costW: 0.01 });
      mk('fh', 'Free Hit', [], [fh.squad, ...gwList.slice(1).map(() => base)], 0, { chip: true, chipSquad: fh.ids, note: 'One-week squad, then your team returns.' });
    }
    if (o.chips?.wc) {
      const wc = optimiseSquad(M, budget, gwList, disc, squadIds);
      mk('wc', 'Wildcard', [], rep(wc.squad), 0, { chip: true, chipSquad: wc.ids, money: budget - wc.cost, note: 'New permanent squad.' });
    }
    const roll = out[0];
    out.forEach(s => { s.delta = s.total - roll.total; s.deltaNow = s.pts[0] - roll.pts[0]; });
    return { gwList, list: out, budget, plan: P };
  }


  // ================= 5-GW planner =================
  const CHIP_NAMES = { fh: 'Free Hit', wc: 'Wildcard', bb: 'Bench Boost', tc: 'Triple Captain' };
  const half = g => (g <= 19 ? 1 : 2);
  function squadErrors(M, ids) {
    const errs = [], ps = { 1: 0, 2: 0, 3: 0, 4: 0 }, c = {};
    ids.forEach(id => { const p = M.byId[id]; ps[p.pos]++; c[p.team] = (c[p.team] || 0) + 1; });
    if (ids.length !== 15 || ps[1] !== 2 || ps[2] !== 5 || ps[3] !== 5 || ps[4] !== 3) errs.push('Squad needs 2 GK, 5 DEF, 5 MID, 3 FWD');
    Object.entries(c).forEach(([t, n]) => { if (n > 3) errs.push(`More than 3 players from ${M.teamById[t].short}`); });
    return errs;
  }
  // Points for one GW with chips and an optional captain choice.
  function lineup(M, ids, g, capId, chip) {
    const sq = ids.map(id => M.byId[id]), r = bestXI(sq, g);
    let cap = r.cap, vice = r.vice;
    const pick = capId && r.xi.find(p => p.id === capId); if (pick && pick !== cap) { vice = cap; cap = pick; }
    const ep = p => p.ep[g] || 0, mult = chip === 'tc' ? 3 : 2;
    const xiPts = r.xi.reduce((s, p) => s + ep(p), 0), benchPts = r.bench.reduce((s, p) => s + ep(p), 0);
    return { xi: r.xi, bench: r.bench, cap, vice, mult, xiPts, benchPts, pts: xiPts + (mult - 1) * ep(cap) + (chip === 'bb' ? benchPts : 0) };
  }
  // Apply one week of a plan to a state {base, bank, ft}. Returns the week result and the next state.
  function applyWeek(M, st, g, w) {
    w = w || {}; const chip = w.chip || null, errors = [];
    let base = st.base, bank = st.bank, ft = st.ft, squad, nT = 0, hits = 0;
    const budget = bank + base.reduce((s, id) => s + M.byId[id].cost, 0);
    if (chip === 'fh' || chip === 'wc') {
      squad = w.chipSquad && w.chipSquad.length === 15 ? w.chipSquad.slice() : base.slice();
      errors.push(...squadErrors(M, squad));
      const c = squad.reduce((s, id) => s + M.byId[id].cost, 0);
      if (c > budget + 1e-6) errors.push(`£${(c - budget).toFixed(1)}m over budget`);
      if (chip === 'wc') { base = squad; bank = budget - c; }
      ft = Math.min(5, ft + 1); // saved free transfers are kept when a Wildcard or Free Hit is played
    } else {
      squad = base.slice();
      (w.transfers || []).forEach(([o, i]) => {
        const k = squad.indexOf(o), po = M.byId[o], pi = M.byId[i];
        if (k < 0 || !pi || squad.includes(i) || po.pos !== pi.pos) { errors.push(`${po ? po.name : 'A player'} → ${pi ? pi.name : '?'} isn’t possible here`); return; }
        squad[k] = i; bank += po.cost - pi.cost; nT++;
      });
      if (bank < -1e-6) errors.push(`£${(-bank).toFixed(1)}m over budget`);
      errors.push(...squadErrors(M, squad).filter(e => e.startsWith('More')));
      hits = Math.max(0, nT - ft) * 4; ft = Math.min(5, Math.max(0, ft - nT) + 1); base = squad;
    }
    const r = lineup(M, squad, g, w.captain, chip);
    return { week: { gw: g, chip, squad, nT, hits, ftBefore: st.ft, ftAfter: ft, bankAfter: bank, budget, gross: r.pts, pts: r.pts - hits, lineup: r, errors, transfers: w.transfers || [] }, next: { base, bank, ft } };
  }
  function simulate(M, start, plan, gwList, chipsAvail = {}) {
    let st = { base: start.squad.slice(), bank: start.bank, ft: start.ft }; const weeks = [];
    const uses = {};
    gwList.forEach(g => {
      const w = (plan.weeks || {})[g]; const { week, next } = applyWeek(M, st, g, w);
      if (week.chip) {
        const key = week.chip + half(g); uses[key] = (uses[key] || 0) + 1;
        if (half(g) === half(gwList[0]) && chipsAvail[week.chip] === false) week.errors.push(`${CHIP_NAMES[week.chip]} already used this half of the season`);
        if (uses[key] > 1) week.errors.push(`${CHIP_NAMES[week.chip]} can only be played once per half-season`);
      }
      week.before = st; weeks.push(week); st = next;
    });
    return { weeks, total: weeks.reduce((s, w) => s + w.pts, 0), end: st };
  }
  // Best 0/1/2 transfers for a normal week, valued over the rest of the horizon.
  function suggestWeek(M, st, gwRest, disc, o = {}) {
    const ftValue = o.ftValue ?? 1.2, hitMargin = o.hitMargin ?? 1;
    const base = st.base.map(id => M.byId[id]), owned = new Set(st.base);
    const val = sq => { let v = 0; gwRest.forEach((g, k) => { const r = bestXI(sq, g); v += Math.pow(disc, k) * (r.pts + 0.1 * r.benchPts); }); return v; };
    const hz = p => horizonEP(p, gwRest, disc), v0 = val(base);
    const clubs = {}; base.forEach(p => clubs[p.team] = (clubs[p.team] || 0) + 1);
    const cands = {};
    [1, 2, 3, 4].forEach(ps => {
      const arr = M.players.filter(p => p.pos === ps && !owned.has(p.id) && p.status !== 'u' && p.status !== 'n').map(p => ({ p, h: hz(p) }));
      const top = [...arr].sort((a, b) => b.h - a.h).slice(0, 18);
      const byPrice = [...arr].sort((a, b) => a.p.cost - b.p.cost); let best = -1; const fr = [];
      byPrice.forEach(x => { if (x.h > best + 0.1) { fr.push(x); best = x.h; } });
      const seen = new Set(); cands[ps] = [...top, ...fr].filter(x => !seen.has(x.p.id) && seen.add(x.p.id)).map(x => x.p);
    });
    const tryMove = (outs, ins) => {
      let money = st.bank; const cc = { ...clubs };
      outs.forEach(p => { money += p.cost; cc[p.team]--; }); for (const p of ins) { money -= p.cost; cc[p.team] = (cc[p.team] || 0) + 1; if (cc[p.team] > 3) return null; }
      if (money < -1e-9) return null;
      const outIds = new Set(outs.map(p => p.id)); const sq = base.filter(p => !outIds.has(p.id)).concat(ins);
      return { outs, ins, gain: val(sq) - v0 };
    };
    const singles = [];
    base.forEach(op => cands[op.pos].forEach(ip => { const r = tryMove([op], [ip]); if (r && r.gain > 0) singles.push(r); }));
    singles.sort((a, b) => b.gain - a.gain);
    const doubles = [];
    const ts = singles.slice(0, 24);
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i], b = ts[j]; if (a.outs[0] === b.outs[0] || a.ins[0] === b.ins[0]) continue;
      const r = tryMove([a.outs[0], b.outs[0]], [a.ins[0], b.ins[0]]); if (r) doubles.push(r);
    }
    // sell two to fund one big upgrade
    for (let i = 0; i < 15; i++) for (let j = i + 1; j < 15; j++) {
      const a = base[i], b = base[j], ca = cands[a.pos].slice(0, 8), cb = cands[b.pos].slice(0, 8);
      ca.forEach(x => cb.forEach(y => { if (x.id !== y.id) { const r = tryMove([a, b], [x, y]); if (r) doubles.push(r); } }));
    }
    const score = (n, gain) => gain - Math.max(0, n - st.ft) * (4 + hitMargin) + ftValue * (Math.min(5, Math.max(st.ft - n, 0) + 1) - Math.min(5, st.ft + 1));
    let best = { n: 0, t: [], s: 0 };
    if (singles[0]) { const s1 = score(1, singles[0].gain); if (s1 > best.s) best = { n: 1, t: [singles[0]], s: s1 }; }
    doubles.forEach(d => { const s2 = score(2, d.gain); if (s2 > best.s) best = { n: 2, t: [d], s: s2 }; });
    return best.n === 0 ? [] : best.t[0].outs.map((p, k) => [p.id, best.t[0].ins[k].id]);
  }
  // Fill a plan week by week: chips from the schedule, suggested transfers elsewhere. Weeks in `keep` are left as they are.
  function autoPlan(M, start, schedule, gwList, o = {}) {
    const disc = o.discount ?? 0.85, keep = o.keep || {}, weeks = {};
    let st = { base: start.squad.slice(), bank: start.bank, ft: start.ft };
    gwList.forEach((g, k) => {
      let w;
      if (keep[g]) w = keep[g];
      else {
        const chip = schedule[g] || null; w = { chip };
        const budget = st.bank + st.base.reduce((s, id) => s + M.byId[id].cost, 0);
        if (chip === 'fh') w.chipSquad = optimiseSquad(M, budget, [g], 1, st.base, { benchW: 0.005, costW: 0.01 }).ids;
        else if (chip === 'wc') w.chipSquad = optimiseSquad(M, budget, gwList.slice(k), disc, st.base).ids;
        else w.transfers = o.noTransfers ? [] : suggestWeek(M, st, gwList.slice(k), disc, o);
      }
      weeks[g] = w; st = applyWeek(M, st, g, w).next;
    });
    return { weeks };
  }
  function scenarioList(gwList, chipsAvail) {
    const g0 = gwList[0], g1 = gwList[1], L = [
      { key: 'keep', name: 'Keep your team', desc: 'No transfers for 5 weeks', schedule: {}, noTransfers: true },
      { key: 'transfers', name: 'Transfers only', desc: 'Best free transfers each week, no chips', schedule: {} }];
    if (chipsAvail.fh !== false) L.push({ key: 'fh', name: `Free Hit GW${g0}`, desc: `Free Hit now, then the best transfers`, schedule: { [g0]: 'fh' } });
    if (chipsAvail.wc !== false) L.push({ key: 'wc', name: `Wildcard GW${g0}`, desc: `Wildcard now, then the best transfers`, schedule: { [g0]: 'wc' } });
    if (chipsAvail.wc !== false && g1) L.push({ key: 'wc1', name: `Wildcard GW${g1}`, desc: `Transfers now, Wildcard next week`, schedule: { [g1]: 'wc' } });
    if (chipsAvail.fh !== false && chipsAvail.wc !== false && g1) L.push({ key: 'fhwc', name: `Free Hit GW${g0}, Wildcard GW${g1}`, desc: 'Free Hit now, Wildcard next week, then transfers', schedule: { [g0]: 'fh', [g1]: 'wc' } });
    return L;
  }
  // Best week to play Triple Captain / Bench Boost on top of a simulated plan.
  function chipTiming(M, sim, chipsAvail) {
    const out = {};
    const free = sim.weeks.filter(w => !w.chip);
    if (chipsAvail.tc !== false && free.length) { const b = free.reduce((a, w) => (w.lineup.cap.ep[w.gw] || 0) > (a.lineup.cap.ep[a.gw] || 0) ? w : a); out.tc = { gw: b.gw, gain: b.lineup.cap.ep[b.gw] || 0, who: b.lineup.cap.name }; }
    if (chipsAvail.bb !== false && free.length) { const b = free.reduce((a, w) => w.lineup.benchPts > a.lineup.benchPts ? w : a); out.bb = { gw: b.gw, gain: b.lineup.benchPts }; }
    return out;
  }
  // Plain-English rationale for a player's prediction in one GW.
  function explain(M, p, g) {
    const d = p.detail[g] || [], T = id => M.teamById[id].short, lines = [], f2 = x => x.toFixed(2), pc = x => Math.round(x * 100) + '%';
    if (!d.length) return [{ k: 'No match', v: 0, why: `${T(p.team)} don’t play in GW${g}.` }];
    const sum = k => d.reduce((s, x) => s + (x[k] || 0), 0), M0 = d[0].M;
    const av = Math.round(avail(p, M.horizonGWs.indexOf(g)) * 100);
    lines.push({ k: 'Minutes', v: sum('app'), why: p.overridden ? `You set ${Math.round(p.baseMin)} minutes.` : `Expects about ${Math.round(M0)} minutes${d.length > 1 ? ' per match' : ''}: ${p.minRecent != null ? Math.round(p.minRecent) + ' a game recently, ' : ''}${Math.round(p.minSeason)} a game this season${av < 100 ? `, ${av}% chance of being fit` : ''}. Starting and playing 60+ minutes is worth 2 points.` });
    d.forEach(x => {
      const opp = T(x.opp) + (x.home ? ' (H)' : ' (A)'), oppConcede = M.def[x.opp], oppScore = M.att[x.opp];
      if (p.pos >= 2 && x.xG > 0.005) lines.push({ k: `Goals v ${opp}`, v: x.g, why: `${f2(p.xg90)} xG per 90 (season ${f2(p.xg90s)}, last 6 games ${f2(p.xg90r)}). ${T(x.opp)} concede ${f2(oppConcede)} xG a game against a league average of ${f2(M.mu)}, so ${T(p.team)} are expected to score ${f2(x.lf)}. His share works out at ${f2(x.xG)} goals.` });
      if (x.xA > 0.005) lines.push({ k: `Assists v ${opp}`, v: x.a, why: `${f2(p.xa90 * ASSIST_K)} expected FPL assists per 90 (xA scaled by 1.35, because FPL gives more assists than xA counts), so ${f2(x.xA)} assists in this match.` });
      if (p.pos <= 3) lines.push({ k: `Clean sheet v ${opp}`, v: x.cs + x.gc, why: `${T(x.opp)} create ${f2(oppScore)} xG a game, so they’re expected to score ${f2(x.la)} here: a ${pc(x.pcs)} clean-sheet chance${p.pos <= 2 ? `, minus expected points lost for goals conceded (${f2(-x.gc)})` : ''}.` });
      if (p.pos === 1) lines.push({ k: 'Saves', v: x.sv, why: `About ${x.svMean.toFixed(1)} saves expected (1 point per 3).` });
      if (p.pos >= 2 && x.pdc > 0.01) lines.push({ k: 'Defensive contribution', v: x.dc, why: `Averages ${(p.dc90).toFixed(1)} ${p.pos === 2 ? 'CBIT' : 'CBIRT'} per 90: a ${pc(x.pdc)} chance of reaching ${p.pos === 2 ? 10 : 12} for 2 points.` });
    });
    lines.push({ k: 'Bonus', v: sum('bonus'), why: `${p.bonus90.toFixed(2)} bonus points per 90 this season, adjusted for the fixture.` });
    if (sum('yc') < -0.02) lines.push({ k: 'Cards', v: sum('yc'), why: `${(p.yc90).toFixed(2)} yellow cards per 90.` });
    return lines;
  }

  G.FPLModel = { build, plan, bestXI, horizonEP, POS, avail, optimiseSquad, strategies, simulate, applyWeek, suggestWeek, autoPlan, scenarioList, chipTiming, explain, lineup, squadErrors, CHIP_NAMES };
})(typeof window !== 'undefined' ? window : globalThis);
