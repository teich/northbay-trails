import { Park, Region, Trail } from './data';
import { Rides } from './rides';
import { PlanGroup, Progress, planGroup, trailColor } from './trails';

interface Handlers {
  onSelect: (id: number | null, opts?: { fly?: boolean }) => void;
  onHover: (id: number | null) => void;
  onProgress: (p: Progress) => void;
  /** a park or region was picked (null = everywhere): its id, the parks it covers, and its trails */
  onPark: (id: string | null, parks: string[], trailIds: number[]) => void;
  /** the ridden log changed */
  onRidden: () => void;
  onPlans: (groups: Set<PlanGroup>) => void;
  /** whether a trail is visible under the current filter + plan overlay */
  matches: (t: Trail) => boolean;
  onHome: () => void;
  onRotate: (dir: number) => void;
  onZoom: (factor: number) => void;
}

/** Phone layout: the panel becomes a bottom sheet and the trail card slides up over it */
export const mobile = matchMedia('(max-width: 700px)');

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export class UI {
  private progress: Progress = 'all';
  private park: string | null = null;
  private plansOn = false;
  private planGroups = new Set<PlanGroup>(['new', 'decommission']);
  private query = '';
  private results: Trail[] = [];
  private active = -1;
  private selected: number | null = null;
  private list = $('#trail-list');
  private search = $<HTMLInputElement>('#search');
  private card = $('#card');

  constructor(
    private trails: Trail[],
    private parks: Park[],
    private regions: Region[],
    private rides: Rides,
    private h: Handlers,
  ) {
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.active = -1;
      this.render();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.results.length;
        if (!n) return;
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.highlightActive();
        this.h.onHover(this.results[this.active].id);
      } else if (e.key === 'Enter') {
        const t = this.results[Math.max(0, this.active)];
        if (t) this.h.onSelect(t.id);
      } else if (e.key === 'Escape') {
        this.search.value = '';
        this.query = '';
        this.render();
        this.search.blur();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== this.search) {
        e.preventDefault();
        this.search.focus();
        this.search.select();
      }
    });
    $('#search-clear').addEventListener('click', () => {
      this.search.value = '';
      this.query = '';
      this.render();
      this.search.focus();
    });

    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-progress]')) {
      btn.addEventListener('click', () => {
        this.progress = btn.dataset.progress as Progress;
        document.querySelectorAll('[data-progress]').forEach((b) => b.classList.toggle('on', b === btn));
        this.h.onProgress(this.progress);
        this.render();
      });
    }

    const parkBar = $('#parks');
    parkBar.innerHTML =
      `<div class="views"><button data-park="" class="on">Everywhere</button>` +
      regions.map((r) => `<button data-park="${r.id}" title="${escape(r.long)}">${escape(r.name)}<small>${escape(r.long)}</small></button>`).join('') +
      `</div>` +
      parks.map((p) => `<button data-park="${p.id}" title="${escape(p.long)}">${escape(p.name)}</button>`).join('');
    parkBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-park]');
      if (btn) this.setPark(btn.dataset.park || null);
    });

    rides.onChange(() => {
      this.updateProgress();
      this.render();
      if (this.selected !== null) this.updateRideButton(this.trails[this.selected]);
      this.h.onRidden();
    });
    $('#rides-export').addEventListener('click', () => rides.export());
    const file = $<HTMLInputElement>('#rides-file');
    $('#rides-import').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const added = rides.import(await f.text());
        alert(`Imported. ${added} more trail${added === 1 ? '' : 's'} marked ridden.`);
      } catch (err) {
        alert(`Couldn't read that file: ${(err as Error).message}`);
      }
      file.value = '';
    });

    const planBtn = $('#plan-btn');
    planBtn.addEventListener('click', () => this.setPlans(!this.plansOn));
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-plan]')) {
      btn.addEventListener('click', () => {
        const g = btn.dataset.plan as PlanGroup;
        if (this.planGroups.has(g)) this.planGroups.delete(g);
        else this.planGroups.add(g);
        btn.classList.toggle('on', this.planGroups.has(g));
        this.h.onPlans(new Set(this.planGroups));
        this.render();
      });
    }

    this.list.addEventListener('click', (e) => {
      const check = (e.target as HTMLElement).closest<HTMLElement>('[data-ride]');
      if (check) {
        e.stopPropagation();
        this.rides.toggle(this.trails[Number(check.dataset.ride)]);
        return;
      }
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (li) this.h.onSelect(Number(li.dataset.id));
    });
    this.list.addEventListener('mouseover', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      this.h.onHover(li ? Number(li.dataset.id) : null);
    });
    this.list.addEventListener('mouseleave', () => this.h.onHover(null));

    $('#btn-home').addEventListener('click', () => this.h.onHome());
    $('#btn-left').addEventListener('click', () => this.h.onRotate(-1));
    $('#btn-right').addEventListener('click', () => this.h.onRotate(1));
    $('#btn-in').addEventListener('click', () => this.h.onZoom(1.6));
    $('#btn-out').addEventListener('click', () => this.h.onZoom(1 / 1.6));

    this.setupSheet();
    this.updateProgress();
    this.render();
  }

  /** On phones the panel is a bottom sheet: a peek (title + search) that expands to the full list */
  private setupSheet() {
    const panel = $('#panel');
    const handle = $('#sheet-handle');
    const grip = [handle, $('#panel header')];
    let startY: number | null = null;
    for (const el of grip) {
      el.addEventListener('pointerdown', (e) => {
        if (mobile.matches) startY = e.clientY;
      });
      el.addEventListener('pointerup', (e) => {
        if (startY === null) return;
        const dy = e.clientY - startY;
        startY = null;
        // a swipe sets the direction; a tap toggles
        this.setSheet(Math.abs(dy) > 24 ? dy < 0 : !panel.classList.contains('expanded'));
      });
      el.addEventListener('pointercancel', () => (startY = null));
    }
    this.search.addEventListener('focus', () => {
      if (mobile.matches) this.setSheet(true);
    });
    // the credits live at the bottom of the sheet on phones, in the corner of the map otherwise
    const credits = $('#attribution');
    // (resize too: the media query's change event doesn't always fire, e.g. under device emulation)
    const sync = () => {
      const home = mobile.matches ? panel : document.body;
      if (credits.parentElement !== home) home.appendChild(credits);
      if (!mobile.matches) this.setSheet(false);
    };
    mobile.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    sync();
  }

  setSheet(expanded: boolean) {
    $('#panel').classList.toggle('expanded', expanded);
    $('#sheet-handle').setAttribute('aria-expanded', String(expanded));
  }

  /** The park ids a scope covers: one park, a region's parks, or (null) every park */
  private scopeParks(id: string | null = this.park): string[] {
    if (!id) return this.parks.map((p) => p.id);
    if (this.regions.some((r) => r.id === id)) return this.parks.filter((p) => p.region === id).map((p) => p.id);
    return [id];
  }

  private inScope(t: Trail, id: string | null = this.park) {
    if (!id) return true;
    if (this.regions.some((r) => r.id === id)) return t.region === id;
    return t.park === id;
  }

  /** Show one park's or region's trails in the list (null = all of them), and tell the map to fly there */
  setPark(id: string | null, fly = true) {
    this.park = id;
    document.querySelectorAll<HTMLElement>('[data-park]').forEach((b) => b.classList.toggle('on', (b.dataset.park || null) === id));
    this.updateProgress();
    this.render();
    // on a phone, get the sheet out of the way so the map can show where we're going
    if (fly && mobile.matches) this.setSheet(false);
    if (fly) this.h.onPark(id, this.scopeParks(id), this.trails.filter((t) => !t.road && !t.plan && this.inScope(t, id)).map((t) => t.id));
  }

  private updateProgress() {
    const inScope = this.trails.filter((t) => !t.plan && !t.road && this.inScope(t));
    const done = inScope.filter((t) => this.rides.has(t));
    const miles = inScope.reduce((a, t) => a + t.lengthMi, 0);
    const doneMiles = done.reduce((a, t) => a + t.lengthMi, 0);
    const region = this.regions.find((r) => r.id === this.park);
    const where = !this.park ? 'all parks' : region ? `${region.name} · ${region.long}` : this.parks.find((p) => p.id === this.park)!.name;
    $('#stats').textContent = `${inScope.length} trails · ${Math.round(miles).toLocaleString()} miles · ${where}`;
    const pct = miles ? (doneMiles / miles) * 100 : 0;
    $('#progress-fill').style.width = `${pct}%`;
    $('#progress-text').innerHTML =
      `<b>${done.length}</b> of ${inScope.length} trails ridden · <b>${doneMiles.toFixed(1)}</b> of ${miles.toFixed(1)} mi` +
      (inScope.length && done.length === inScope.length ? ' · <b>all done! 🎉</b>' : '');
  }

  setPlans(on: boolean, include?: PlanGroup) {
    if (include) {
      this.planGroups.add(include);
      document.querySelector(`[data-plan="${include}"]`)?.classList.add('on');
    }
    this.plansOn = on;
    $('#plan-btn').setAttribute('aria-pressed', String(on));
    $('#plan-btn').closest('.plan-toggle')!.classList.toggle('on', on);
    $('#plan-groups').hidden = !on;
    $('#legend').hidden = on;
    $('#legend-plan').hidden = !on;
    this.h.onPlans(on ? new Set(this.planGroups) : new Set());
    this.render();
  }

  private render() {
    const q = norm(this.query);
    const words = q.split(' ').filter(Boolean);
    let results = this.trails.filter((t) => !t.road && this.h.matches(t) && this.inScope(t));
    if (words.length) {
      results = results
        .map((t) => {
          const hay = norm(`${t.name} ${t.area ?? ''}`);
          if (!words.every((w) => hay.includes(w))) return null;
          const name = norm(t.name);
          const score = (name.startsWith(q) ? 0 : name.split(' ').some((w) => w.startsWith(words[0])) ? 1 : 2) - t.lengthMi / 1000;
          return { t, score };
        })
        .filter((r): r is { t: Trail; score: number } => r !== null)
        .sort((a, b) => a.score - b.score)
        .map((r) => r.t);
    }
    this.results = results;
    $('#search-clear').hidden = !this.query;
    $('#result-count').textContent = words.length ? `${results.length} match${results.length === 1 ? '' : 'es'}` : `${results.length} trails`;
    if (!results.length) {
      this.list.innerHTML = `<li class="empty">No trails match “${escape(this.query)}”. Try a shorter word?</li>`;
      return;
    }
    const item = (t: Trail) => {
      const ridden = this.rides.has(t);
      return `<li data-id="${t.id}" class="${t.id === this.selected ? 'selected' : ''}${ridden ? ' ridden' : ''}">
          ${t.plan ? swatch(t) : `<button class="ride-check" data-ride="${t.id}" aria-pressed="${ridden}" title="${ridden ? `Ridden ${this.rides.date(t)} · click to unmark` : 'Mark as ridden'}">${ridden ? '✓' : ''}</button>`}
          ${t.plan ? '' : ridden ? '<span class="swatch ridden"></span>' : swatch(t)}
          <span class="li-name"><span>${escape(t.name)}${ratingMark(t)}</span>${t.plan ? `<small class="plan-tag">${planSummary(t)}</small>` : t.area ? `<small>${escape(t.area)}</small>` : ''}</span>
          <span class="li-len">${t.lengthMi}<small>mi</small></span>
        </li>`;
    };
    const singlePark = this.park !== null && !this.regions.some((r) => r.id === this.park);
    if (!singlePark && !this.plansOn && !words.length) {
      // one section per park, west to east, then the trails outside the parks, grouped by the
      // open space they're in (biggest groups first), with the rest last
      const section = (title: string, ts: Trail[]) => (ts.length ? `<li class="section">${escape(title)} · ${ts.length}</li>${ts.map(item).join('')}` : '');
      const parkSections = this.parks
        .filter((p) => this.scopeParks().includes(p.id))
        .map((p) => section(p.long, results.filter((t) => t.park === p.id)));
      const places = new Map<string, Trail[]>();
      for (const t of results) {
        if (t.park || !t.place) continue;
        if (!places.has(t.place)) places.set(t.place, []);
        places.get(t.place)!.push(t);
      }
      const placeSections = [...places].sort((a, b) => b[1].length - a[1].length).map(([name, ts]) => section(name, ts));
      const loose = section('Other trails', results.filter((t) => !t.park && !t.place));
      this.list.innerHTML = [...parkSections, ...placeSections, loose].join('');
      return;
    }
    if (this.plansOn && !words.length) {
      // planned changes first, then everything that exists today
      const planned = results.filter((t) => t.plan);
      const existing = results.filter((t) => !t.plan);
      this.list.innerHTML =
        (planned.length ? `<li class="section">Planned · ${planned.length}</li>${planned.map(item).join('')}` : '') +
        `<li class="section">On the ground today · ${existing.length}</li>${existing.map(item).join('')}`;
      return;
    }
    this.list.innerHTML = results.map(item).join('');
  }

  private highlightActive() {
    this.list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === this.active));
    this.list.querySelectorAll('li')[this.active]?.scrollIntoView({ block: 'nearest' });
  }

  showTrail(t: Trail | null) {
    this.selected = t ? t.id : null;
    this.list.querySelectorAll<HTMLElement>('li[data-id]').forEach((li) => {
      const on = t !== null && Number(li.dataset.id) === t.id;
      li.classList.toggle('selected', on);
      if (on) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    if (!t) {
      this.card.classList.remove('open');
      document.body.classList.remove('card-open');
      history.replaceState(null, '', location.pathname);
      return;
    }
    history.replaceState(null, '', `#${t.plan ? 'plan' : 'trail'}=${encodeURIComponent(t.name)}`);
    if (t.plan) return this.showPlan(t);

    this.setScopeFor(t);
    const uses = [
      t.hike ? `<span class="chip hike">🥾 Hiking</span>` : '',
      t.bike
        ? `<span class="chip bike">🚵 Mountain bikes${t.bikeInferred ? '<em>likely allowed</em>' : ''}</span>`
        : t.bikePartial
          ? `<span class="chip bike">🚵 Bikes on part of it</span>`
          : `<span class="chip nobike">No bikes${t.wilderness ? ' · wilderness' : ''}</span>`,
    ].join('');

    const details: [string, string | null][] = [
      ['Trail rating', t.rating ? `${ratingMark(t)} ${RATING_NAME[t.rating]}` : null],
      ['Technical grade', t.mtbScale !== null ? `S${t.mtbScale} <small>(${t.difficulty})</small>` : null],
      ['Hike difficulty', t.hikeDifficulty],
      ['Surface', t.surface ? escape(t.surface.replace(/_/g, ' ')) : null],
      ['Managed by', t.operator ? escape(t.operator) : null],
      ['Type', t.fireRoad ? 'Fire road' : 'Singletrack / trail'],
      ['Elevation', `${t.minFt.toLocaleString()}′ – ${t.maxFt.toLocaleString()}′`],
      [
        'Source',
        t.sources.includes('osm')
          ? t.sources.includes('csp')
            ? 'OpenStreetMap · confirmed by California State Parks'
            : 'OpenStreetMap'
          : 'California State Parks',
      ],
    ];

    this.card.innerHTML = `
      <button id="card-close" class="icon-btn" aria-label="Close">✕</button>
      <p class="eyebrow">${escape([this.parks.find((p) => p.id === t.park)?.long ?? t.place, t.area].filter(Boolean).join(' · '))}</p>
      <h2>${escape(t.name)}</h2>
      <button id="card-ride" class="ride-toggle"></button>
      <div class="chips">${uses}</div>
      <div class="stats">
        <div><b>${t.lengthMi}</b><span>miles</span></div>
        <div><b><i>↗</i>${t.gainFt.toLocaleString()}′</b><span>climbing</span></div>
        <div><b><i>↘</i>${t.lossFt.toLocaleString()}′</b><span>descending</span></div>
      </div>
      ${profileSvg(t)}
      <dl>${details
        .filter(([, v]) => v)
        .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
        .join('')}</dl>
      <button id="card-zoom" class="text-btn">↺ Zoom to trail</button>
    `;
    this.openCard(t);
  }

  /** Keep the list on a trail picked on the map, without flying anywhere: its park, or its region */
  private setScopeFor(t: Trail) {
    if (this.inScope(t)) return;
    this.setPark(t.park ?? t.region ?? null, false);
  }

  private updateRideButton(t: Trail) {
    const btn = document.getElementById('card-ride');
    if (!btn) return;
    const date = this.rides.date(t);
    btn.classList.toggle('on', date !== null);
    btn.innerHTML = date
      ? `<span class="box">✓</span><span>Ridden<small>${new Date(date + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · click to unmark</small></span>`
      : `<span class="box"></span><span>Still to ride<small>click when you've ridden it</small></span>`;
  }

  private openCard(t: Trail) {
    const ride = document.getElementById('card-ride');
    if (ride) {
      ride.addEventListener('click', () => this.rides.toggle(t));
      this.updateRideButton(t);
    }
    $('#card-close').addEventListener('click', () => this.h.onSelect(null));
    $('#card-zoom').addEventListener('click', () => this.h.onSelect(t.id));
    this.card.classList.add('open');
    document.body.classList.add('card-open');
    if (mobile.matches) {
      this.setSheet(false);
      this.search.blur();
      this.card.scrollTop = 0;
    }
  }

  private showPlan(t: Trail) {
    const plan = t.plan!;
    const group = planGroup(t)!;
    const chip = (cls: string, text: string) => `<span class="chip ${cls}">${text}</span>`;
    let chips = '';
    let change = '';
    let season: string | null = null;
    const EBIKE_SEASON = 'E-bikes April 1 – November 15';
    const MOTO_SEASON = 'Motorcycles May 25 – November 15';
    if (plan.kind === 'decommission') {
      chips = chip('nobike', '✕ To be decommissioned');
      change = 'Trail to be closed and restored (often replaced by a reroute nearby)';
    } else if (plan.kind === 'designate') {
      chips =
        plan.mode === 'moto'
          ? chip('moto', '🏍️ Opening to motorcycles')
          : chip('ebike', '⚡ Opening to Class 1 e-bikes') + chip('hike', '🥾 Hiking') + chip('bike', '🚵 Bikes');
      change = 'Existing trail, new designation';
      season = plan.mode === 'moto' ? MOTO_SEASON : EBIKE_SEASON;
    } else {
      if (plan.mode === 'moto') chips = chip('moto', '🏍️ Motorcycles');
      else {
        chips = chip('hike', '🥾 Hiking');
        if (plan.mode !== 'foot') chips += chip('bike', '🚵 Bikes');
        chips += plan.mode === 'ebike' ? chip('ebike', '⚡ Class 1 e-bikes') : chip('nobike', plan.mode === 'foot' ? 'No bikes' : 'No e-bikes');
      }
      change = plan.kind === 'adopt' ? 'Existing user-made trail, adopted into the official system' : 'New trail construction';
      season = plan.mode === 'moto' ? MOTO_SEASON : plan.mode === 'ebike' ? EBIKE_SEASON : null;
    }
    const details: [string, string | null][] = [
      ['Change', change],
      ['Season', season],
      ['Project note', plan.note ? escape(plan.note.charAt(0).toUpperCase() + plan.note.slice(1)) : null],
      ['Elevation', `${t.minFt.toLocaleString()}′ – ${t.maxFt.toLocaleString()}′`],
      [
        'Source',
        '<a href="https://www.fs.usda.gov/r05/laketahoebasin/projects/54566" target="_blank" rel="noopener">USFS Basin Wide Trails Analysis</a>, decision signed Jan 9, 2026',
      ],
    ];
    this.card.innerHTML = `
      <button id="card-close" class="icon-btn" aria-label="Close">✕</button>
      <p class="eyebrow"><span class="stamp plan" style="color:${'#' + trailColor(t).getHexString()}">Approved plan · 2026</span>${group === 'new' ? 'not built yet' : ''}</p>
      <h2>${escape(t.name)}</h2>
      <div class="chips">${chips}</div>
      <div class="stats">
        <div><b>${t.lengthMi}</b><span>miles</span></div>
        <div><b><i>↗</i>${t.gainFt.toLocaleString()}′</b><span>climbing</span></div>
        <div><b><i>↘</i>${t.lossFt.toLocaleString()}′</b><span>descending</span></div>
      </div>
      ${plan.kind === 'decommission' ? '' : profileSvg(t)}
      <dl>${details
        .filter(([, v]) => v)
        .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
        .join('')}</dl>
      <p class="fineprint">Alignment is planning-level from the project’s GIS. Built routes may shift, and construction is phased over several years.</p>
      <button id="card-zoom" class="text-btn">↺ Zoom to trail</button>
    `;
    this.openCard(t);
  }
}

const RATING_NAME: Record<string, string> = {
  green: 'Easy (green circle)',
  blue: 'Intermediate (blue square)',
  black: 'Difficult (black diamond)',
  'double-black': 'Expert (double black diamond)',
};

/** The green circle / blue square / black diamond(s) for a rated trail */
function ratingMark(t: Trail) {
  if (!t.rating) return '';
  const shape = t.rating === 'green' ? '●' : t.rating === 'blue' ? '■' : t.rating === 'black' ? '◆' : '◆◆';
  return `<i class="rating ${t.rating}" title="${RATING_NAME[t.rating]}">${shape}</i>`;
}

function swatch(t: Trail) {
  if (!t.plan) return `<span class="swatch ${t.bike ? 'bike' : 'hike'}"></span>`;
  return `<span class="swatch plan" style="--c:#${trailColor(t).getHexString()}" data-kind="${planGroup(t)}"></span>`;
}

export function planSummary(t: Trail) {
  const p = t.plan!;
  if (p.kind === 'decommission') return 'to be removed';
  if (p.kind === 'designate') return p.mode === 'moto' ? 'opening to motorcycles' : 'opening to e-bikes';
  const what = p.kind === 'adopt' ? 'adopted trail' : 'new trail';
  const who = { ebike: 'bikes + e-bikes', nonmoto: 'no e-bikes', foot: 'hike only', moto: 'motorcycles', none: '' }[p.mode];
  return `${what} · ${who}`;
}

// Elevation profile of the longest continuous stretch, painted as a watercolor wash.
function profileSvg(t: Trail): string {
  const line = t.lines.reduce((a, b) => (b.length > a.length ? b : a));
  const pts: [number, number][] = [];
  let d = 0;
  for (let i = 0; i < line.length; i += 3) {
    if (i) d += Math.hypot(line[i] - line[i - 3], line[i + 1] - line[i - 2]);
    pts.push([d, line[i + 2]]);
  }
  if (pts.length < 2) return '';
  // orient west→east-ish consistently: start at the lower end
  if (pts[0][1] > pts[pts.length - 1][1]) {
    const total = d;
    pts.reverse();
    for (const p of pts) p[0] = total - p[0];
  }
  const W = 320;
  const H = 86;
  const minE = Math.min(...pts.map((p) => p[1]));
  const maxE = Math.max(...pts.map((p) => p[1]));
  const range = Math.max(60, maxE - minE);
  const x = (v: number) => (v / d) * W;
  const y = (v: number) => H - 8 - ((v - minE) / range) * (H - 22);
  const step = Math.max(1, Math.floor(pts.length / 160));
  const sampled = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const top = sampled.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const area = `${top}L${W},${H}L0,${H}Z`;
  const multi = t.lines.length > 1 ? `<span>longest continuous section</span>` : '';
  const ft = (m: number) => `${Math.round(m * 3.28084).toLocaleString()}′`;
  const stroke = '#' + trailColor(t).getHexString();
  return `
    <figure class="profile">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Elevation profile">
        <defs>
          <filter id="wc" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" seed="${t.id % 50}" />
            <feDisplacementMap in="SourceGraphic" scale="5" />
          </filter>
          <linearGradient id="pg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="${stroke}" stop-opacity="0.6" />
            <stop offset="1" stop-color="${stroke}" stop-opacity="0.12" />
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#pg)" filter="url(#wc)" />
        <path d="${top}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" filter="url(#wc)" vector-effect="non-scaling-stroke" />
      </svg>
      <figcaption><span>${ft(minE)} → ${ft(maxE)}</span>${multi}<span>${(d / 1609.34).toFixed(1)} mi</span></figcaption>
    </figure>`;
}
