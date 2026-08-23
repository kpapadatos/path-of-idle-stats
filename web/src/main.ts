import 'zone.js';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

type TelemetryEvent = { type: string; timestamp?: string; payload?: unknown } & Record<string, unknown>;
type TelemetryState = {
  connected: boolean;
  gameRunning: boolean;
  updatedAt: string | null;
  heroes: unknown[];
  slots: Array<{ battleIndex: number; heroes: unknown[] }>;
  resources: unknown[];
  inventory: unknown[];
  battles: TelemetryEvent[];
  events: TelemetryEvent[];
  catalogs: Record<string, any[]>;
};

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <main class="mx-auto max-w-7xl p-3 md:p-5">
      <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-3xl font-semibold tracking-tight">Path of Idle Stats</h1>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" (click)="refreshHeroes()" [disabled]="refreshing()" class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 hover:border-amber-700 disabled:opacity-50">{{ refreshing() ? 'Requested…' : 'Refresh heroes' }}</button>
          <div class="rounded-full border px-3 py-1.5 text-sm" [class]="gameStatusClass()">
            <span class="mr-2 inline-block h-2 w-2 rounded-full" [class]="gameDotClass()"></span>{{ state().gameRunning ? 'Game running' : 'Game stopped' }}
          </div>
          <div class="rounded-full border px-3 py-1.5 text-sm" [class]="statusClass()">
            <span class="mr-2 inline-block h-2 w-2 rounded-full" [class]="dotClass()"></span>{{ status() }}
          </div>
        </div>
      </header>

      <section class="mb-3 grid grid-cols-3 gap-2" aria-label="Primary resources">
        <article *ngFor="let resource of primaryResources(); trackBy: trackResource" [attr.aria-label]="resourceTitle($any(resource)) + ': ' + resourceCount($any(resource))" class="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <img *ngIf="$any(resource).iconUrl" [src]="$any(resource).iconUrl" class="h-7 w-7 object-contain" alt="">
          <p class="font-mono text-sm font-semibold text-zinc-100">{{ resourceCount($any(resource)) }}</p>
        </article>
      </section>

      <section class="space-y-3">
        <article *ngFor="let slot of battleSlots" class="rounded-2xl border border-zinc-700 bg-gradient-to-br from-zinc-900 to-zinc-950 p-3 shadow-xl shadow-black/20">
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button type="button" *ngFor="let position of heroPositions" (click)="slotHeroes(slot)[position] && openHero(slotHeroes(slot)[position])" class="min-h-14 rounded-xl border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-left transition hover:border-amber-700 hover:bg-zinc-900">
              <ng-container *ngIf="slotHeroes(slot)[position] as hero; else emptyHero">
                <div class="flex min-w-0 items-center gap-2 text-sm">
                    <img [src]="$any(hero).classIconUrl || classIconUrl($any(hero).jobId)" class="h-5 w-5 shrink-0 object-contain" alt="">
                    <p class="min-w-0 flex-1 truncate font-medium text-zinc-100">{{ $any(hero).name || 'Unnamed hero' }}</p>
                    <span class="shrink-0 text-xs text-zinc-500">Lv. {{ $any(hero).level ?? '?' }}</span>
                </div>
              </ng-container>
              <ng-template #emptyHero><div class="flex h-8 items-center justify-center text-sm text-zinc-700">Empty hero slot</div></ng-template>
            </button>
          </div>

          <details class="group mt-3 rounded-xl border border-zinc-800 bg-zinc-950/70">
            <summary class="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm font-medium text-zinc-300">
              <span>Battle history ({{ slotBattles(slot).length }}) - Rift-Star Expanse-15 Avg. Time: {{ riftStarAverage(slot) }}</span>
              <span class="ml-4 flex shrink-0 items-center gap-3">
                <button type="button" (click)="$event.preventDefault(); $event.stopPropagation(); resetSlot(slot)" [disabled]="!slotBattles(slot).length" class="rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950 disabled:cursor-not-allowed disabled:opacity-40">Reset history</button>
                <span class="text-zinc-600 transition-transform group-open:rotate-180">⌄</span>
              </span>
            </summary>
            <div class="border-t border-zinc-800 p-4">
              <p *ngIf="!slotBattles(slot).length" class="text-sm text-zinc-600">Waiting for this slot’s first completed battle.</p>
              <details *ngFor="let battle of slotBattles(slot); trackBy: trackBattle" class="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/70">
                <summary class="cursor-pointer list-none p-3">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div><p class="text-sm font-medium text-zinc-200">{{ $any(battle).payload?.englishPlaceTitle || $any(battle).payload?.placeTitle || placeTitleFallback($any(battle).payload) }}</p><div class="mt-1 flex items-center gap-3"><span class="rounded-md px-2 py-1 text-xs uppercase" [class]="battleResultClass($any(battle).payload?.result)">{{ $any(battle).payload?.result || 'unknown' }}</span><span class="text-sm text-zinc-300">{{ $any(battle).payload?.durationSeconds ?? '?' }}s</span></div></div>
                    <span class="text-xs text-zinc-600">{{ $any(battle).timestamp | date:'mediumTime' }}</span>
                  </div>
                </summary>
                <div class="border-t border-zinc-800 p-3">
                  <div class="grid gap-3 text-xs sm:grid-cols-3"><p class="text-zinc-500">Enemies <span class="ml-1 text-zinc-200">{{ $any(battle).payload?.enemyCount ?? 0 }}</span></p><p class="text-zinc-500">Wave <span class="ml-1 text-zinc-200">{{ $any(battle).payload?.wave ?? '?' }}</span></p><p class="text-zinc-500">Mode <span class="ml-1 text-zinc-200">{{ $any(battle).payload?.adventureType || '?' }}</span></p></div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <span *ngFor="let item of battleLoot($any(battle)); trackBy: trackLoot" class="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                      <img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-5 w-5 rounded object-contain" alt="">
                      {{ $any(item).englishName || $any(item).name || 'Unknown item' }}<span *ngIf="$any(item).count > 1" class="text-zinc-500">×{{ $any(item).count }}</span>
                    </span>
                    <span *ngIf="!battleLoot($any(battle)).length" class="text-xs text-zinc-600">No loot recorded</span>
                  </div>
                </div>
              </details>
            </div>
          </details>
        </article>
      </section>

      <section class="mt-3 rounded-2xl border border-zinc-700 bg-zinc-950 p-3">
        <div class="mb-3 flex items-end justify-between gap-3"><div><h2 class="font-semibold text-zinc-100">Loot speed</h2><p class="text-xs text-zinc-500">Combined hourly rate across the retained battle history.</p></div><span class="text-xs text-zinc-600">{{ state().battles.length }} battles</span></div>
        <div *ngIf="lootRates().length; else noLootRates" class="grid grid-cols-2 items-start gap-1.5">
          <div *ngFor="let column of lootRateColumns()" class="grid gap-1.5">
            <article *ngFor="let item of column; trackBy: trackLootRate" class="flex min-w-0 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1">
              <img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-6 w-6 shrink-0 object-contain" alt="">
              <p class="min-w-0 flex-1 truncate text-sm text-zinc-300">{{ $any(item).englishName || $any(item).name || 'Unknown item' }}</p>
              <span class="shrink-0 font-mono text-sm font-semibold text-amber-300">{{ lootRateLabel($any(item).perHour) }}/h</span>
            </article>
          </div>
        </div>
        <ng-template #noLootRates><p class="py-4 text-center text-sm text-zinc-600">Waiting for completed battles with loot.</p></ng-template>
      </section>

      <div *ngIf="selectedHero() as hero" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" (click)="closeHero()">
        <section role="dialog" aria-modal="true" [attr.aria-label]="($any(hero).name || 'Hero') + ' details'" class="flex h-[92vh] max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl" (click)="$event.stopPropagation()">
          <header class="shrink-0 flex items-start justify-between gap-4">
            <div>
              <h2 class="text-xl font-semibold text-zinc-100">{{ $any(hero).name || 'Unnamed hero' }}</h2>
              <div class="mt-1 flex items-center gap-2 text-sm text-amber-300"><img [src]="$any(hero).classIconUrl || classIconUrl($any(hero).jobId)" class="h-5 w-5 object-contain" alt="">{{ $any(hero).englishJob || $any(hero).job || 'Unknown class' }} · Level {{ $any(hero).level ?? '?' }}</div>
            </div>
            <button type="button" (click)="closeHero()" class="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-white">Close</button>
          </header>

          <nav class="mt-5 flex shrink-0 gap-1 border-b border-zinc-800" role="tablist" aria-label="Hero details">
            <button type="button" role="tab" (click)="selectedHeroTab.set('talents')" [attr.aria-selected]="selectedHeroTab() === 'talents'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedHeroTab() === 'talents' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Talents</button>
            <button type="button" role="tab" (click)="selectedHeroTab.set('stats')" [attr.aria-selected]="selectedHeroTab() === 'stats'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedHeroTab() === 'stats' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Stats</button>
          </nav>

          <div class="min-h-0 flex-1 overflow-y-auto pr-1">
          <ng-container *ngIf="selectedHeroTab() === 'talents'">

          <section *ngIf="inspiredTalents($any(hero)).length" class="mt-6 rounded-xl border border-cyan-950 bg-cyan-950/10 p-4 text-center">
            <p class="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-400">Inspired talents</p>
            <div class="flex flex-wrap justify-center gap-5"><ng-container *ngFor="let talent of inspiredTalents($any(hero))"><ng-container *ngTemplateOutlet="talentNode; context: { $implicit: talent }"></ng-container></ng-container></div>
          </section>

          <div class="mt-6 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div class="grid min-w-[560px] grid-cols-5 grid-rows-6 gap-x-8 gap-y-6">
              <div *ngFor="let node of talentTree($any(hero))" class="relative flex min-h-20 items-center justify-center" [style.grid-column]="node.column" [style.grid-row]="node.row">
                <ng-container *ngTemplateOutlet="talentNode; context: { $implicit: node.talent }"></ng-container>
              </div>
            </div>
          </div>

          <div *ngIf="fixedSkills($any(hero)).length || unpositionedSkills($any(hero)).length" class="mt-6 grid grid-cols-2 gap-4">
            <section class="rounded-xl border border-amber-950 bg-amber-950/10 p-4 text-center">
              <p class="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-amber-400">Basic skills</p>
              <div class="flex flex-wrap justify-center gap-5"><ng-container *ngFor="let talent of fixedSkills($any(hero))"><ng-container *ngTemplateOutlet="talentNode; context: { $implicit: talent }"></ng-container></ng-container></div>
            </section>
            <section class="rounded-xl border border-violet-950 bg-violet-950/10 p-4 text-center">
              <p class="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-violet-400">Mutated skills</p>
              <div class="flex flex-wrap justify-center gap-5"><ng-container *ngFor="let talent of unpositionedSkills($any(hero))"><ng-container *ngTemplateOutlet="talentNode; context: { $implicit: talent }"></ng-container></ng-container></div>
            </section>
          </div>

          <ng-template #talentNode let-talent>
            <div class="flex w-24 flex-col items-center" [attr.data-talent-id]="$any(talent).id">
              <div class="relative h-12 w-12 border bg-zinc-950 p-1" [class]="talentBorderClass(talent)" [class.rounded-lg]="$any(talent).skillId" [class.rounded-full]="!$any(talent).skillId">
                <img *ngIf="$any(talent).iconUrl" [src]="$any(talent).iconUrl" class="h-full w-full object-contain" [class.rounded]="$any(talent).skillId" [class.rounded-full]="!$any(talent).skillId" alt="">
                <span class="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-200">{{ $any(talent).effectiveRank ?? $any(talent).rank ?? 0 }}/{{ $any(talent).maxRank ?? '?' }}</span>
                <span *ngIf="$any(talent).selected" class="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-950">Selected</span>
              </div>
              <p class="mt-3 w-full truncate text-center text-[11px] text-zinc-300">{{ $any(talent).englishName || $any(talent).name || 'Unknown' }}</p>
            </div>
          </ng-template>

          <p class="mt-3 text-xs text-zinc-600">Hover a talent or skill for its full details.</p>
          </ng-container>

          <section *ngIf="selectedHeroTab() === 'stats'" class="mt-6">
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p class="text-sm text-zinc-400">Current values and the live values after combat effects are applied.</p>
              <button type="button" (click)="refreshHeroes()" [disabled]="refreshing()" class="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-300 hover:bg-amber-950 disabled:opacity-50">{{ refreshing() ? 'Refreshing…' : 'Refresh stats now' }}</button>
            </div>
            <div class="grid gap-4 md:grid-cols-2">
              <section class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 class="mb-3 text-center text-sm font-semibold text-zinc-200">Current hero stats</h3>
                <div *ngIf="heroStats($any(hero), false).length; else noCurrentStats" class="divide-y divide-zinc-800">
                  <div *ngFor="let stat of heroStats($any(hero), false); trackBy: trackStat" [attr.data-stat-key]="statKey(stat, false)" class="flex items-center justify-between gap-4 px-2 py-2 text-sm hover:bg-zinc-800/60">
                    <span class="min-w-0 truncate text-zinc-400">{{ statName($any(stat)) }}</span>
                    <span class="shrink-0 font-mono text-zinc-100">{{ statListValue($any(stat)) }}</span>
                  </div>
                </div>
                <ng-template #noCurrentStats><p class="py-8 text-center text-sm text-zinc-600">Refresh to capture hero stats.</p></ng-template>
              </section>
              <section class="rounded-xl border border-rose-950 bg-rose-950/10 p-4">
                <h3 class="mb-3 text-center text-sm font-semibold text-rose-200">Live combat stats</h3>
                <div *ngIf="heroStats($any(hero), true).length; else noCombatStats" class="divide-y divide-zinc-800">
                  <div *ngFor="let stat of heroStats($any(hero), true); trackBy: trackStat" [attr.data-stat-key]="statKey(stat, true)" class="flex items-center justify-between gap-4 px-2 py-2 text-sm hover:bg-zinc-800/60">
                    <span class="min-w-0 truncate text-zinc-400">{{ statName($any(stat)) }}</span>
                    <span class="shrink-0 font-mono text-rose-100">{{ statListValue($any(stat)) }}</span>
                  </div>
                </div>
                <ng-template #noCombatStats><p class="py-8 text-center text-sm text-zinc-600">No live combat values were captured.</p></ng-template>
              </section>
            </div>
          </section>
          </div>

          <div id="talent-tooltip" *ngIf="hoveredTalent() as talent" class="pointer-events-none fixed left-0 top-0 z-[70] w-72 rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-left shadow-2xl will-change-transform">
            <p class="font-medium text-amber-200">{{ $any(talent).englishName || $any(talent).name }}</p>
            <p class="mt-1 text-xs text-zinc-400">Rank {{ $any(talent).effectiveRank ?? $any(talent).rank ?? 0 }} / {{ $any(talent).maxRank ?? '?' }}<span *ngIf="$any(talent).skillId"> · Skill {{ $any(talent).skillId }}</span></p>
            <p *ngIf="$any(talent).englishDescription || $any(talent).description" class="mt-2 text-xs leading-relaxed text-zinc-300">{{ $any(talent).englishDescription || $any(talent).description }}</p>
            <div *ngIf="talentTags($any(talent)).length" class="mt-2 flex flex-wrap gap-1"><span *ngFor="let tag of talentTags($any(talent))" class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">{{ tag }}</span></div>
          </div>
          <div id="stat-tooltip" *ngIf="hoveredStat() as stat" class="pointer-events-none fixed left-0 top-0 z-[70] w-80 rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-left shadow-2xl will-change-transform">
            <p class="font-medium text-amber-200">{{ $any(stat).englishName || $any(stat).name || $any(stat).key }}</p>
            <p class="mt-1 font-mono text-sm text-zinc-100">{{ statValue($any(stat)) }}</p>
            <p *ngIf="$any(stat).englishDescription || $any(stat).description" class="mt-2 text-xs leading-relaxed text-zinc-300">{{ $any(stat).englishDescription || $any(stat).description }}</p>
            <p *ngIf="$any(stat).explanation || $any(stat).specialDescription" class="mt-2 border-t border-zinc-800 pt-2 text-xs leading-relaxed text-zinc-400">{{ $any(stat).explanation || $any(stat).specialDescription }}</p>
            <p class="mt-2 text-[10px] text-zinc-600">Internal: {{ $any(stat).key }} · ID {{ $any(stat).id }}</p>
          </div>
        </section>
      </div>

    </main>
  `
})
class AppComponent implements OnInit, OnDestroy {
  readonly battleSlots = [0, 1, 2];
  readonly heroPositions = [0, 1, 2];
  readonly selectedHero = signal<any | null>(null);
  readonly selectedHeroTab = signal<'talents' | 'stats'>('talents');
  readonly hoveredTalent = signal<any | null>(null);
  readonly hoveredStat = signal<any | null>(null);
  readonly refreshing = signal(false);
  readonly state = signal<TelemetryState>({ connected: false, gameRunning: false, updatedAt: null, heroes: [], slots: [], resources: [], inventory: [], battles: [], events: [], catalogs: {} });
  readonly status = signal('Connecting');
  private stream?: EventSource;
  private tooltipFrame?: number;

  async ngOnInit() {
    try {
      const [live, catalogs] = await Promise.all([
        fetch('/api/state').then(response => response.json()),
        fetch('/api/catalogs').then(response => response.json())
      ]);
      this.state.set({ ...live, catalogs });
    } catch { /* server stream will retry */ }
    this.stream = new EventSource('/api/stream');
    this.stream.onopen = () => this.status.set('Backend connected');
    this.stream.onerror = () => this.status.set('Reconnecting');
    this.stream.onmessage = event => {
      const next = { ...JSON.parse(event.data), catalogs: this.state().catalogs } as TelemetryState;
      this.state.set(next);
      const selected = this.selectedHero();
      if (!selected) return;
      const fresh = next.slots.flatMap(slot => slot.heroes as any[]).find(hero => this.heroIdentity(hero) === this.heroIdentity(selected));
      if (fresh) this.selectedHero.set(fresh);
    };
  }
  ngOnDestroy() { this.stream?.close(); if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame); }
  slotBattles(slot: number): TelemetryEvent[] { return this.state().battles.filter(battle => Number((battle as any).payload?.battleIndex) === slot); }
  trackBattle(index: number, battle: TelemetryEvent): string {
    return String(battle.timestamp ?? `${(battle as any).payload?.battleIndex ?? 'slot'}-${index}`);
  }
  trackLoot(index: number, item: any): string { return `${item?.type ?? 'item'}:${item?.id ?? item?.englishName ?? index}`; }
  battleLoot(battle: TelemetryEvent): any[] {
    const result: any[] = [];
    const stackIndexes = new Map<string, number>();
    for (const item of ((battle as any)?.payload?.loot || [])) {
      const type = String(item?.type || 'unknown');
      const key = `${type}:${item?.id ?? item?.englishName ?? result.length}`;
      const stackable = type.toLowerCase() !== 'equip';
      const existingIndex = stackable ? stackIndexes.get(key) : undefined;
      if (existingIndex != null) {
        result[existingIndex] = { ...result[existingIndex], count: Number(result[existingIndex]?.count || 0) + Number(item?.count || 0) };
      } else {
        if (stackable) stackIndexes.set(key, result.length);
        result.push({ ...item });
      }
    }
    return result;
  }
  primaryResources(): any[] {
    const live = new Map((this.state().resources || []).map((resource: any) => [Number(resource?.id), resource]));
    const definitions = new Map((this.state().catalogs?.['materials'] || []).map((resource: any) => [Number(resource?.id), resource]));
    return [1, 2, 3].map(id => ({ ...(definitions.get(id) || {}), ...(live.get(id) || {}), id }));
  }
  trackResource(_index: number, resource: any): number { return Number(resource?.id); }
  resourceTitle(resource: any): string {
    if (Number(resource?.id) === 3) return 'Bones';
    return String(resource?.englishName || resource?.name || ({ 1: 'Gold', 2: 'Blood' } as Record<number, string>)[Number(resource?.id)] || 'Resource');
  }
  resourceCount(resource: any): string {
    const count = Number(resource?.count);
    return Number.isFinite(count) ? Math.floor(count).toLocaleString('en-US') : '—';
  }
  lootRates(): any[] {
    const durationBySlot = new Map<number, number>();
    const itemByKey = new Map<string, any>();
    const countsByKeyAndSlot = new Map<string, Map<number, number>>();
    for (const battle of this.state().battles) {
      const payload = (battle as any)?.payload || {};
      const slot = Number(payload.battleIndex);
      const duration = Number(payload.durationSeconds);
      if (!Number.isFinite(slot) || !Number.isFinite(duration) || duration <= 0) continue;
      durationBySlot.set(slot, (durationBySlot.get(slot) || 0) + duration);
      for (const item of this.battleLoot(battle)) {
        const key = `${item?.type || 'item'}:${item?.id ?? item?.englishName ?? item?.name}`;
        itemByKey.set(key, item);
        const counts = countsByKeyAndSlot.get(key) || new Map<number, number>();
        counts.set(slot, (counts.get(slot) || 0) + Number(item?.count || 0));
        countsByKeyAndSlot.set(key, counts);
      }
    }
    return [...itemByKey.entries()].map(([key, item]) => {
      const perHour = [...(countsByKeyAndSlot.get(key) || new Map()).entries()]
        .reduce((rate, [slot, count]) => rate + Number(count) * 3600 / Number(durationBySlot.get(Number(slot)) || Infinity), 0);
      return { ...item, key, perHour };
    }).filter(item => Number.isFinite(item.perHour) && item.perHour > 0)
      .sort((left, right) => right.perHour - left.perHour);
  }
  trackLootRate(_index: number, item: any): string { return String(item?.key); }
  lootRateColumns(): any[][] {
    const rates = this.lootRates();
    const split = Math.ceil(rates.length / 2);
    return [rates.slice(0, split), rates.slice(split)];
  }
  lootRateLabel(rate: number): string {
    if (!Number.isFinite(rate)) return '—';
    return rate >= 100 ? Math.round(rate).toLocaleString('en-US') : rate.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }
  trackStat(_index: number, stat: any): string { return String(stat?.id ?? stat?.key); }
  statKey(stat: any, combat: boolean): string { return (combat ? 'combat:' : 'current:') + String(stat?.id ?? stat?.key); }
  heroStats(hero: any, combat: boolean): any[] {
    const currentStats = Array.isArray(hero?.stats) ? hero.stats : null;
    if (combat && currentStats && Array.isArray(hero?.combatStats)) {
      const combatByKey = new Map(hero.combatStats.map((stat: any) => [String(stat?.id ?? stat?.key), stat]));
      return currentStats
        .map((stat: any) => combatByKey.get(String(stat?.id ?? stat?.key)))
        .filter((stat: any) => stat != null);
    }
    const stats = combat ? hero?.combatStats : currentStats;
    if (Array.isArray(stats)) return stats;
    return combat ? [] : Object.entries(hero?.attributes || {}).map(([key, value]) => ({ key, englishName: key, value }));
  }
  statValue(stat: any): string {
    const value = Number(stat?.value);
    if (!Number.isFinite(value)) return String(stat?.value ?? '—');
    const formatted = value.toLocaleString('en-US', { maximumFractionDigits: 3 });
    return Number(stat?.valueType) === 2 ? formatted + '%' : formatted;
  }
  statListValue(stat: any): string {
    const value = Number(stat?.value);
    if (!Number.isFinite(value)) return String(stat?.value ?? '—');
    const formatted = Math.floor(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
    return Number(stat?.valueType) === 2 ? formatted + '%' : formatted;
  }
  statName(stat: any): string {
    const name = String(stat?.englishName || stat?.name || '').trim();
    const key = this.humanizeStatKey(String(stat?.key || 'Unknown'));
    return Number(stat?.showType) === 0 && name && name !== key ? `${name} (${key})` : name || key;
  }
  private humanizeStatKey(key: string): string {
    return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, value => value.toUpperCase());
  }
  private heroIdentity(hero: any): string { return String(hero?.uniqueId ?? hero?.id ?? hero?.name ?? ''); }
  riftStarAverage(slot: number): string {
    const targetTitle = 'Rift-Star Expanse-15';
    const durations = this.slotBattles(slot)
      .filter(battle => this.battlePlaceTitle((battle as any).payload) === targetTitle)
      .slice(0, 50)
      .map(battle => Number((battle as any).payload?.durationSeconds))
      .filter(duration => Number.isFinite(duration));
    if (!durations.length) return 'n/a';
    return (durations.reduce((sum, duration) => sum + duration, 0) / durations.length).toFixed(3) + 's';
  }
  private battlePlaceTitle(payload: any): string {
    return String(payload?.englishPlaceTitle || payload?.placeTitle || this.placeTitleFallback(payload));
  }
  slotHeroes(slot: number): any[] {
    const liveSlot = this.state().slots?.find(entry => Number(entry.battleIndex) === slot);
    const heroes = liveSlot?.heroes ?? (this.slotBattles(slot)[0] as any)?.payload?.heroes ?? [];
    return [...heroes].reverse();
  }
  async refreshHeroes() {
    this.refreshing.set(true);
    try { await fetch('/api/snapshot', { method: 'POST' }); }
    finally { window.setTimeout(() => this.refreshing.set(false), 700); }
  }
  battleResultClass(result: unknown) { return String(result).toLowerCase().includes('win') ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'; }
  openHero(hero: any) { this.selectedHero.set(hero); this.selectedHeroTab.set('talents'); }
  closeHero() { this.selectedHero.set(null); this.hoveredTalent.set(null); this.hoveredStat.set(null); }
  async resetSlot(slot: number) {
    const response = await fetch('/api/battles/' + slot, { method: 'DELETE' });
    if (!response.ok) throw new Error('Could not reset battle history');
  }
  @HostListener('document:pointermove', ['$event'])
  onDocumentPointerMove(event: PointerEvent) {
    if (!this.selectedHero()) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const statRow = target?.closest<HTMLElement>('[data-stat-key]');
    if (statRow) {
      const [kind, id] = String(statRow.dataset['statKey']).split(':');
      const stat = this.heroStats(this.selectedHero(), kind === 'combat').find(candidate => String(candidate?.id ?? candidate?.key) === id);
      if (stat) { this.hoveredTalent.set(null); this.positionTooltip(event, stat, 'stat-tooltip', this.hoveredStat); return; }
    }
    const tile = target?.closest<HTMLElement>('[data-talent-id]');
    if (!tile) { this.hideTalentTooltip(); return; }
    const id = Number(tile.dataset['talentId']);
    const talent = (this.selectedHero()?.talents || []).find((candidate: any) => Number(candidate?.id) === id);
    if (!talent) { this.hideTalentTooltip(); return; }
    this.hoveredStat.set(null);
    this.positionTooltip(event, talent, 'talent-tooltip', this.hoveredTalent);
  }
  @HostListener('document:mouseleave')
  @HostListener('window:blur')
  hideTalentTooltip() { if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame); this.tooltipFrame = undefined; this.hoveredTalent.set(null); this.hoveredStat.set(null); }
  private positionTooltip(event: PointerEvent, value: any, elementId: string, targetSignal: { (): any; set(value: any): void }) {
    if (targetSignal() !== value) targetSignal.set(value);
    const pointerX = event.clientX, pointerY = event.clientY;
    if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame);
    this.tooltipFrame = requestAnimationFrame(() => {
      const tooltip = document.getElementById(elementId);
      if (!tooltip) return;
      const rect = tooltip.getBoundingClientRect();
      const x = pointerX + rect.width + 24 > window.innerWidth ? pointerX - rect.width - 14 : pointerX + 14;
      const y = pointerY + rect.height + 24 > window.innerHeight ? pointerY - rect.height - 14 : pointerY + 14;
      tooltip.style.transform = `translate3d(${Math.max(8, x)}px, ${Math.max(8, y)}px, 0)`;
    });
  }
  talentTree(hero: any): Array<{ talent: any; column: number; row: number }> {
    const talents = (Array.isArray(hero?.talents) ? hero.talents : []).filter((talent: any) => Number(talent?.position) > 0 && !talent?.inspired);
    const rowOffset = talents.some((talent: any) => Number(talent?.positionRow) === 0) ? 1 : 0;
    const columnOffset = talents.some((talent: any) => Number(talent?.positionColumn) === 0) ? 1 : 0;
    return talents.map((talent: any, index: number) => {
      const legacyIndex = Math.max(0, Number(talent?.position || 1) % 100 - 1);
      const rawRow = talent?.positionRow == null ? Math.floor(legacyIndex / 5) + 1 : Number(talent.positionRow) + rowOffset;
      const rawColumn = talent?.positionColumn == null ? legacyIndex % 5 + 1 : Number(talent.positionColumn) + columnOffset;
      return { talent, row: Math.max(1, Math.min(6, rawRow)), column: Math.max(1, Math.min(5, rawColumn)) };
    });
  }
  inspiredTalents(hero: any): any[] { return (hero?.talents || []).filter((talent: any) => talent?.inspired); }
  fixedSkills(hero: any): any[] { return (hero?.talents || []).filter((talent: any) => talent?.fixed && talent?.skillId && Number(talent?.position || 0) === 0); }
  unpositionedSkills(hero: any): any[] { return (hero?.talents || []).filter((talent: any) => Number(talent?.position || 0) === 0 && !talent?.inspired && !(talent?.fixed && talent?.skillId)); }
  talentTags(talent: any): string[] {
    return [talent?.fixed && 'fixed', talent?.inspired && 'inspired', talent?.alien && 'alien', talent?.skillId && 'skill'].filter(Boolean) as string[];
  }
  talentBorderClass(talent: any) {
    const hasRank = Number(talent?.effectiveRank ?? talent?.rank ?? 0) > 0;
    return talent?.selected ? 'border-emerald-400 ring-2 ring-emerald-500/40'
      : talent?.alien ? 'border-violet-600'
      : talent?.inspired ? 'border-cyan-600'
      : talent?.fixed ? 'border-amber-600'
      : !talent?.skillId && hasRank ? 'border-amber-600'
      : 'border-zinc-700';
  }
  classIconUrl(jobId: unknown) {
    const files: Record<number, string> = {
      1: 'bb2632af3674b8f0ebe2e6951cf8aaffef395686ffc4c421e1a5b460122b882e.png',
      2: '41135556b62a59bc1f160ec2f399b0b612614037d7fb0fb5d61426bbfe21ab52.png',
      3: '423b9fd07b969d966837c26e7b6d7ca0d87707e63a1110905966fafc1fc421fd.png',
      4: '0c2ac2a577bf09c8b1b0cf1d48f483e97c757a9d1c16be38322a6e86b0209102.png',
      5: '382cd89f39c67bf4a5f21a16747384d14e2ceba618012f8f5c62768683c3fc4f.png',
      6: 'af3c89802050c44d8ecd58803bf82e52f5656061ca34b5e39dd0f0ec88381b1e.png'
    };
    return files[Number(jobId)] ? '/assets/icons/' + files[Number(jobId)] : '';
  }
  placeTitleFallback(payload: any) { return payload?.adventureType ? String(payload.adventureType) : 'Unknown place'; }
  statusClass() { return this.status() === 'Backend connected' ? 'border-emerald-800 bg-emerald-950 text-emerald-300' : 'border-amber-800 bg-amber-950 text-amber-300'; }
  dotClass() { return this.status() === 'Backend connected' ? 'bg-emerald-400' : 'bg-amber-400'; }
  gameStatusClass() { return this.state().gameRunning ? 'border-emerald-800 bg-emerald-950 text-emerald-300' : 'border-zinc-700 bg-zinc-900 text-zinc-500'; }
  gameDotClass() { return this.state().gameRunning ? 'bg-emerald-400' : 'bg-zinc-600'; }
}

bootstrapApplication(AppComponent).catch(console.error);
