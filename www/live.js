// Live FPL data. Works inside the Android app, where native HTTP bypasses the browser's cross-site block.
(function (G) {
  const BASE = 'https://fantasy.premierleague.com/api/';
  const isNative = () => !!(G.Capacitor && G.Capacitor.isNativePlatform && G.Capacitor.isNativePlatform());
  async function get(path) {
    const r = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`FPL returned ${r.status} for ${path}`);
    const t = await r.text();
    try { return JSON.parse(t); } catch { throw new Error('FPL sent something that is not data (the game may be updating)'); }
  }
  const KEEP = ['id', 'web_name', 'team', 'element_type', 'now_cost', 'status', 'chance_of_playing_next_round', 'news', 'minutes', 'starts', 'expected_goals', 'expected_assists', 'expected_goals_conceded', 'saves', 'bonus', 'defensive_contribution', 'yellow_cards', 'total_points', 'form', 'selected_by_percent', 'penalties_order'];
  // Slim official JSON into what the model needs. recent = minutes in the last 6 finished GWs.
  function slim(b, fx, lives, evIds) {
    const teamGW = {};
    fx.forEach(f => { if (!f.event) return; (teamGW[f.team_h] ||= new Set()).add(f.event); (teamGW[f.team_a] ||= new Set()).add(f.event); });
    const mins = evIds.map((_, i) => { const m = {}; (lives[i].elements || []).forEach(e => m[e.id] = e.stats ? e.stats.minutes : 0); return m; });
    const recent = {};
    b.elements.forEach(e => { recent[e.id] = evIds.map((g, i) => teamGW[e.team] && teamGW[e.team].has(g) ? (mins[i][e.id] ?? 0) : null); });
    const done = b.events.filter(e => e.finished).map(e => e.id);
    return {
      bootstrap: { teams: b.teams.map(t => ({ id: t.id, name: t.name, short_name: t.short_name })), events: b.events.map(e => ({ id: e.id, finished: e.finished, is_current: e.is_current, is_next: e.is_next, deadline_time: e.deadline_time })), elements: b.elements.map(e => { const o = {}; KEEP.forEach(k => o[k] = e[k]); return o; }) },
      fixtures: fx.map(f => ({ id: f.id, event: f.event, kickoff_time: f.kickoff_time, team_h: f.team_h, team_a: f.team_a, finished: f.finished, team_h_score: f.team_h_score, team_a_score: f.team_a_score })),
      recent,
      meta: { source: 'Live from FPL', snapshot: new Date().toISOString(), statsThroughGW: done.length ? Math.max(...done) : null, live: true }
    };
  }
  async function loadData(step = () => {}) {
    step('Downloading players and injury news');
    const b = await get('bootstrap-static/');
    step('Downloading fixtures');
    const fx = await get('fixtures/');
    const evIds = b.events.filter(e => e.finished).map(e => e.id).slice(-6);
    step('Checking recent minutes');
    const lives = await Promise.all(evIds.map(id => get(`event/${id}/live/`)));
    return slim(b, fx, lives, evIds);
  }
  // Free transfers available for the next deadline, from the manager's history (estimate).
  function estimateFT(hist) {
    const chips = hist.chips || [];
    let ft = null;
    [...(hist.current || [])].sort((a, b) => a.event - b.event).forEach(h => {
      if (ft === null) { ft = 1; return; }
      const chip = chips.find(c => c.event === h.event && (c.name === 'wildcard' || c.name === 'freehit'));
      if (!chip) ft = Math.max(0, ft - (h.event_transfers || 0));
      ft = Math.min(5, ft + 1);
    });
    return ft ?? 1;
  }
  function chipsLeft(hist, nextGW) {
    const half = g => (g <= 19 ? 1 : 2), used = (hist.chips || []).filter(c => half(c.event) === half(nextGW)).map(c => c.name);
    return { wc: !used.includes('wildcard'), fh: !used.includes('freehit'), bb: !used.includes('bboost'), tc: !used.includes('3xc') };
  }
  async function loadTeam(id, step = () => {}) {
    step('Finding your team');
    const entry = await get(`entry/${id}/`);
    const ce = entry.current_event;
    if (!ce) throw new Error('This team has not played a gameweek yet');
    step('Loading your squad');
    let picks = await get(`entry/${id}/event/${ce}/picks/`);
    if (picks.active_chip === 'freehit' && ce > 1) picks = await get(`entry/${id}/event/${ce - 1}/picks/`); // squad reverts after Free Hit
    const hist = await get(`entry/${id}/history/`);
    return {
      id, name: entry.name, manager: `${entry.player_first_name} ${entry.player_last_name}`.trim(), event: ce,
      squad: picks.picks.map(p => p.element), bank: (picks.entry_history?.bank ?? 0) / 10,
      ft: estimateFT(hist), chips: chipsLeft(hist, ce + 1), rank: entry.summary_overall_rank, points: entry.summary_overall_points
    };
  }
  G.FPLLive = { isNative, loadData, loadTeam, estimateFT, chipsLeft };
})(typeof window !== 'undefined' ? window : globalThis);
