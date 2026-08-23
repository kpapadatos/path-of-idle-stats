import 'zone.js';
import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

type TelemetryEvent = { type: string; timestamp?: string; payload?: unknown } & Record<string, unknown>;
type TelemetryState = {
  connected: boolean;
  updatedAt: string | null;
  heroes: unknown[];
  slots: Array<{ battleIndex: number; heroes: unknown[] }>;
  inventory: unknown[];
  battles: TelemetryEvent[];
  events: TelemetryEvent[];
  catalogs: Record<string, any[]>;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  template: `
    <main class="mx-auto max-w-7xl p-5 md:p-8">
      <header class="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-amber-400">Local telemetry</p>
          <h1 class="text-3xl font-semibold tracking-tight">Path of Idle Stats</h1>
          <p class="mt-2 text-sm text-zinc-400">Heroes, equipment and battle outcomes as the game reports them.</p>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" (click)="refreshHeroes()" [disabled]="refreshing()" class="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 hover:border-amber-700 disabled:opacity-50">{{ refreshing() ? 'Requested…' : 'Refresh heroes' }}</button>
          <div class="rounded-full border px-3 py-1.5 text-sm" [class]="statusClass()">
            <span class="mr-2 inline-block h-2 w-2 rounded-full" [class]="dotClass()"></span>{{ status() }}
          </div>
        </div>
      </header>

      <section class="space-y-5">
        <article *ngFor="let slot of battleSlots" class="rounded-2xl border border-zinc-700 bg-gradient-to-br from-zinc-900 to-zinc-950 p-5 shadow-xl shadow-black/20">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <button type="button" *ngFor="let position of heroPositions" (click)="slotHeroes(slot)[position] && openHero(slotHeroes(slot)[position])" class="min-h-28 rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 text-left transition hover:border-amber-700 hover:bg-zinc-900">
              <ng-container *ngIf="slotHeroes(slot)[position] as hero; else emptyHero">
                <div class="min-w-0">
                    <p class="truncate font-medium text-zinc-100">{{ $any(hero).name || 'Unnamed hero' }}</p>
                    <div class="mt-1 flex items-center gap-1.5 text-sm">
                      <img [src]="$any(hero).classIconUrl || classIconUrl($any(hero).jobId)" class="h-5 w-5 object-contain" alt="">
                      <span class="truncate text-amber-300">{{ $any(hero).englishJob || $any(hero).job || 'Unknown class' }}</span>
                    </div>
                    <p class="mt-1 text-xs text-zinc-500">Lv. {{ $any(hero).level ?? '?' }}</p>
                </div>
              </ng-container>
              <ng-template #emptyHero><div class="flex h-20 items-center justify-center text-sm text-zinc-700">Empty hero slot</div></ng-template>
            </button>
          </div>

          <details class="group mt-4 rounded-xl border border-zinc-800 bg-zinc-950/70">
            <summary class="flex cursor-pointer list-none items-center justify-between p-4 text-sm font-medium text-zinc-300">
              Battle history ({{ slotBattles(slot).length }}) - Rift-Star Expanse-15 Avg. Time: {{ riftStarAverage(slot) }}
              <span class="text-zinc-600 transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <div class="border-t border-zinc-800 p-4">
              <div *ngIf="slotBattles(slot).length" class="mb-3 flex justify-end"><button type="button" (click)="resetSlot(slot)" class="rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950">Reset history</button></div>
              <p *ngIf="!slotBattles(slot).length" class="text-sm text-zinc-600">Waiting for this slot’s first completed battle.</p>
              <details *ngFor="let battle of slotBattles(slot)" class="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/70">
                <summary class="cursor-pointer list-none p-3">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div><p class="text-sm font-medium text-zinc-200">{{ $any(battle).payload?.englishPlaceTitle || $any(battle).payload?.placeTitle || placeTitleFallback($any(battle).payload) }}</p><div class="mt-1 flex items-center gap-3"><span class="rounded-md px-2 py-1 text-xs uppercase" [class]="battleResultClass($any(battle).payload?.result)">{{ $any(battle).payload?.result || 'unknown' }}</span><span class="text-sm text-zinc-300">{{ $any(battle).payload?.durationSeconds ?? '?' }}s</span></div></div>
                    <span class="text-xs text-zinc-600">{{ $any(battle).timestamp | date:'mediumTime' }}</span>
                  </div>
                </summary>
                <div class="border-t border-zinc-800 p-3">
                  <div class="grid gap-3 text-xs sm:grid-cols-3"><p class="text-zinc-500">Enemies <span class="ml-1 text-zinc-200">{{ $any(battle).payload?.enemyCount ?? 0 }}</span></p><p class="text-zinc-500">Wave <span class="ml-1 text-zinc-200">{{ $any(battle).payload?.wave ?? '?' }}</span></p><p class="text-zinc-500">Mode <span class="ml-1 text-zinc-200">{{ $any(battle).payload?.adventureType || '?' }}</span></p></div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <span *ngFor="let item of ($any(battle).payload?.loot || [])" class="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                      <img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-5 w-5 rounded object-contain" alt="">
                      {{ $any(item).englishName || $any(item).name || 'Unknown item' }}<span *ngIf="$any(item).count > 1" class="text-zinc-500">×{{ $any(item).count }}</span>
                    </span>
                    <span *ngIf="!$any(battle).payload?.loot?.length" class="text-xs text-zinc-600">No loot recorded</span>
                  </div>
                </div>
              </details>
            </div>
          </details>
        </article>
      </section>

      <div *ngIf="selectedHero() as hero" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" (click)="closeHero()">
        <section role="dialog" aria-modal="true" [attr.aria-label]="($any(hero).name || 'Hero') + ' talents'" class="max-h-[92vh] w-full max-w-5xl overflow-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl" (click)="$event.stopPropagation()">
          <header class="flex items-start justify-between gap-4">
            <div>
              <h2 class="text-xl font-semibold text-zinc-100">{{ $any(hero).name || 'Unnamed hero' }}</h2>
              <div class="mt-1 flex items-center gap-2 text-sm text-amber-300"><img [src]="$any(hero).classIconUrl || classIconUrl($any(hero).jobId)" class="h-5 w-5 object-contain" alt="">{{ $any(hero).englishJob || $any(hero).job || 'Unknown class' }} · Level {{ $any(hero).level ?? '?' }}</div>
            </div>
            <button type="button" (click)="closeHero()" class="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-white">Close</button>
          </header>

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
                <span class="absolute -bottom-2 -right-2 rounded-full border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-200">{{ $any(talent).effectiveRank ?? $any(talent).rank ?? 0 }}/{{ $any(talent).maxRank ?? '?' }}</span>
                <span *ngIf="$any(talent).selected" class="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-950">Selected</span>
              </div>
              <p class="mt-3 w-full truncate text-center text-[11px] text-zinc-300">{{ $any(talent).englishName || $any(talent).name || 'Unknown' }}</p>
            </div>
          </ng-template>

          <div id="talent-tooltip" *ngIf="hoveredTalent() as talent" class="pointer-events-none fixed left-0 top-0 z-[70] w-72 rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-left shadow-2xl will-change-transform">
            <p class="font-medium text-amber-200">{{ $any(talent).englishName || $any(talent).name }}</p>
            <p class="mt-1 text-xs text-zinc-400">Rank {{ $any(talent).effectiveRank ?? $any(talent).rank ?? 0 }} / {{ $any(talent).maxRank ?? '?' }}<span *ngIf="$any(talent).skillId"> · Skill {{ $any(talent).skillId }}</span></p>
            <p *ngIf="$any(talent).englishDescription || $any(talent).description" class="mt-2 text-xs leading-relaxed text-zinc-300">{{ $any(talent).englishDescription || $any(talent).description }}</p>
            <div *ngIf="talentTags($any(talent)).length" class="mt-2 flex flex-wrap gap-1"><span *ngFor="let tag of talentTags($any(talent))" class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">{{ tag }}</span></div>
          </div>
          <p class="mt-3 text-xs text-zinc-600">Hover a talent or skill for its full details.</p>
        </section>
      </div>

    </main>
  `
})
class AppComponent implements OnInit, OnDestroy {
  readonly battleSlots = [0, 1, 2];
  readonly heroPositions = [0, 1, 2];
  readonly selectedHero = signal<any | null>(null);
  readonly hoveredTalent = signal<any | null>(null);
  readonly refreshing = signal(false);
  readonly state = signal<TelemetryState>({ connected: false, updatedAt: null, heroes: [], slots: [], inventory: [], battles: [], events: [], catalogs: {} });
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
    this.stream.onmessage = event => { this.hoveredTalent.set(null); this.state.set({ ...JSON.parse(event.data), catalogs: this.state().catalogs }); };
  }
  ngOnDestroy() { this.stream?.close(); if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame); }
  slotBattles(slot: number): TelemetryEvent[] { return this.state().battles.filter(battle => Number((battle as any).payload?.battleIndex) === slot); }
  riftStarAverage(slot: number): string {
    const targetTitle = 'Rift-Star Expanse-15';
    const durations = this.slotBattles(slot)
      .filter(battle => this.battlePlaceTitle((battle as any).payload) === targetTitle)
      .slice(0, 10)
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
  openHero(hero: any) { this.selectedHero.set(hero); }
  closeHero() { this.selectedHero.set(null); this.hoveredTalent.set(null); }
  async resetSlot(slot: number) {
    const response = await fetch('/api/battles/' + slot, { method: 'DELETE' });
    if (!response.ok) throw new Error('Could not reset battle history');
  }
  @HostListener('document:pointermove', ['$event'])
  onDocumentPointerMove(event: PointerEvent) {
    if (!this.selectedHero()) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const tile = target?.closest<HTMLElement>('[data-talent-id]');
    if (!tile) { this.hideTalentTooltip(); return; }
    const id = Number(tile.dataset['talentId']);
    const talent = (this.selectedHero()?.talents || []).find((candidate: any) => Number(candidate?.id) === id);
    if (!talent) { this.hideTalentTooltip(); return; }
    this.positionTalentTooltip(event, talent);
  }
  @HostListener('document:mouseleave')
  @HostListener('window:blur')
  hideTalentTooltip() { if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame); this.tooltipFrame = undefined; this.hoveredTalent.set(null); }
  private positionTalentTooltip(event: PointerEvent, talent: any) {
    if (this.hoveredTalent() !== talent) this.hoveredTalent.set(talent);
    const pointerX = event.clientX, pointerY = event.clientY;
    if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame);
    this.tooltipFrame = requestAnimationFrame(() => {
      const tooltip = document.getElementById('talent-tooltip');
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
  talentBorderClass(talent: any) { return talent?.selected ? 'border-emerald-400 ring-2 ring-emerald-500/40' : talent?.alien ? 'border-violet-600' : talent?.inspired ? 'border-cyan-600' : talent?.fixed ? 'border-amber-600' : 'border-zinc-700'; }
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
}

bootstrapApplication(AppComponent).catch(console.error);
