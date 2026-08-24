import 'zone.js';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, NgZone, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

type TelemetryEvent = { type: string; timestamp?: string; payload?: unknown } & Record<string, unknown>;
type CombatTimelineEntry = { id: number; capturedAt: number; stats: any[]; effects: any[] };
type CodexRarityKey = 'rare' | 'legendary' | 'set' | 'unique' | 'mythic';
type CodexSnapshot = { updatedAt: string | null; items: any[]; affixPools: Array<{ id: number; stats: any[] }>; rarities: any[] };
type ScannerFilter = { id: string; enabled: boolean; itemKeys: string[]; anchorItemKey: string | null; statIds: number[]; minimumAttributeMatches: number };
type ScannerMatch = any & { _matchedFilterIds: string[] };
type TelemetryState = {
  connected: boolean;
  gameRunning: boolean;
  updatedAt: string | null;
  snapshotUpdatedAt?: string | null;
  inventoryUpdatedAt?: string | null;
  inventoryItemAdded?: TelemetryEvent | null;
  heroes: unknown[];
  slots: Array<{ battleIndex: number; heroes: unknown[] }>;
  resources: unknown[];
  sanctum: { floor?: number | null; resourceBonusRate?: number | null } | null;
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
    <main class="mx-auto flex h-dvh max-w-7xl flex-col overflow-hidden p-3 md:p-5">
      <header class="mb-4 flex shrink-0 flex-wrap items-end justify-between gap-3">
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

      <section class="mb-3 grid shrink-0 grid-cols-4 gap-2" aria-label="Primary resources and Sanctum">
        <article *ngFor="let resource of primaryResources(); trackBy: trackResource" [attr.aria-label]="resourceTitle($any(resource)) + ': ' + resourceCount($any(resource))" class="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <img *ngIf="$any(resource).iconUrl" [src]="$any(resource).iconUrl" class="h-7 w-7 object-contain" alt="">
          <p class="font-mono text-sm font-semibold text-zinc-100">{{ resourceCount($any(resource)) }}</p>
        </article>
        <article class="flex items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm font-semibold text-zinc-100">
          Sanctum Floor {{ sanctumFloor() }} ({{ sanctumBonus() }})
        </article>
      </section>

      <nav class="mb-3 flex shrink-0 gap-1 border-b border-zinc-800" role="tablist" aria-label="Dashboard sections">
        <button type="button" role="tab" (click)="selectPageTab('battles')" [attr.aria-selected]="selectedPageTab() === 'battles'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedPageTab() === 'battles' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Battles</button>
        <button type="button" role="tab" (click)="selectPageTab('compendium')" [attr.aria-selected]="selectedPageTab() === 'compendium'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedPageTab() === 'compendium' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Talents</button>
        <button type="button" role="tab" (click)="selectPageTab('codex')" [attr.aria-selected]="selectedPageTab() === 'codex'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedPageTab() === 'codex' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Codex</button>
        <button type="button" role="tab" (click)="selectPageTab('scanner')" [attr.aria-selected]="selectedPageTab() === 'scanner'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedPageTab() === 'scanner' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Scanner</button>
      </nav>

      <div #pageTabBody class="page-tab-body min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 pb-3">
      <ng-container *ngIf="selectedPageTab() === 'battles'">

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
            <summary class="relative flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm font-medium text-zinc-300">
              <span class="flex min-w-0 items-center gap-1">
                <span class="shrink-0 opacity-50">Battle history ({{ slotBattles(slot).length }}) -</span>
                <button type="button" (click)="toggleMapSelector($event, slot)" class="flex min-w-0 items-center gap-1.5 rounded-md border border-zinc-700/80 bg-zinc-900/80 px-2 py-1 text-zinc-400 transition hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200" [attr.aria-expanded]="mapSelectorSlot() === slot" aria-haspopup="listbox">
                  <span class="truncate">{{ selectedAverageMapLabel(slot) }}</span><i class="fa-solid fa-chevron-down shrink-0 text-[9px]" aria-hidden="true"></i>
                </button>
                <button type="button" (click)="$event.preventDefault(); $event.stopPropagation()" class="chapter-average-info relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-600 transition hover:text-zinc-300 focus-visible:text-zinc-300 focus-visible:outline-none" aria-label="How average time is calculated">
                  <i class="fa-solid fa-circle-info text-xs" aria-hidden="true"></i>
                  <span role="tooltip" class="chapter-average-info__tooltip pointer-events-none absolute left-1/2 top-[calc(100%+0.5rem)] z-[60] w-72 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-left text-xs font-normal leading-relaxed text-zinc-300 shadow-xl shadow-black/70">Average time uses only completed wins for the selected chapter in this battle slot’s retained history.</span>
                </button>
                <div *ngIf="mapSelectorSlot() === slot" (click)="$event.stopPropagation()" class="absolute left-3 top-[calc(100%+0.35rem)] z-50 w-[min(30rem,calc(100%-1.5rem))] rounded-xl border border-zinc-700 bg-zinc-950 p-2 shadow-2xl shadow-black/70">
                  <input #mapSearchInput type="search" [value]="mapSearch()" (input)="setMapSearch($event)" (keydown)="$event.stopPropagation()" placeholder="Search maps" aria-label="Search maps" class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-normal text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500">
                  <div class="mt-2 max-h-72 overflow-y-auto overscroll-contain" role="listbox" [attr.aria-label]="'Average map for battle slot ' + (slot + 1)">
                    <button *ngFor="let map of filteredAverageMaps(slot); trackBy: trackAverageMap" type="button" role="option" [attr.aria-selected]="isAverageMapSelected(slot, map)" (click)="selectAverageMap($event, slot, map)" class="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm font-normal transition hover:bg-zinc-800" [class.bg-zinc-800]="isAverageMapSelected(slot, map)" [class.text-amber-300]="isAverageMapSelected(slot, map)" [class.text-zinc-300]="!isAverageMapSelected(slot, map)">
                      <span class="truncate">{{ $any(map).label }}</span>
                    </button>
                    <p *ngIf="!filteredAverageMaps(slot).length" class="px-3 py-5 text-center text-sm font-normal text-zinc-600">No matching maps in this slot’s history</p>
                  </div>
                </div>
              </span>
              <span class="pointer-events-none absolute left-1/2 -translate-x-1/2">Avg. Time: {{ selectedMapAverage(slot) }}</span>
              <span class="ml-4 flex shrink-0 items-center gap-3">
                <button type="button" (click)="$event.preventDefault(); $event.stopPropagation(); resetSlot(slot)" [disabled]="!slotBattles(slot).length" class="rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-1.5 text-xs font-normal text-zinc-500 transition hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40">Reset history</button>
                <i class="fa-solid fa-chevron-down text-[10px] text-zinc-600 transition-transform group-open:rotate-180" aria-hidden="true"></i>
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
      </ng-container>

      <section *ngIf="selectedPageTab() === 'compendium'" aria-label="Talent compendium">
        <div class="mb-3 flex items-center gap-3">
          <label class="min-w-0 flex-1">
            <span class="sr-only">Search talents</span>
            <input type="search" [value]="talentSearch()" (input)="setTalentSearch($event)" placeholder="Search talents, classes, descriptions, IDs…" class="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-600 focus:ring-1 focus:ring-amber-600">
          </label>
          <div class="flex shrink-0 items-center gap-1 rounded-xl border border-zinc-700 bg-zinc-950 p-1" aria-label="Talent rank">
            <button type="button" (click)="adjustCompendiumRank(-1)" [disabled]="compendiumRank() <= 1" aria-label="Decrease rank" class="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30">−</button>
            <input type="number" min="1" max="15" [value]="compendiumRank()" (input)="setCompendiumRank($event)" aria-label="Talent rank" class="rank-input h-8 w-14 border-x border-zinc-800 bg-transparent text-center font-mono text-sm font-semibold text-amber-300 outline-none">
            <button type="button" (click)="adjustCompendiumRank(1)" [disabled]="compendiumRank() >= 15" aria-label="Increase rank" class="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30">+</button>
          </div>
        </div>

        <section *ngIf="selectedCompendiumTalents().length" class="mb-5 border-b border-zinc-800 pb-5" aria-label="Selected talents">
          <h2 class="mb-2 text-sm font-semibold text-zinc-300">Selected talents</h2>
          <div class="grid grid-cols-3 gap-3">
            <ng-container *ngFor="let talent of selectedCompendiumTalents(); trackBy: trackCompendiumTalent">
              <ng-container *ngTemplateOutlet="compendiumTalentCard; context: { $implicit: talent }"></ng-container>
            </ng-container>
          </div>
        </section>

        <div *ngIf="compendiumTalents().length; else noCompendiumTalents" class="grid grid-cols-3 gap-3">
          <ng-container *ngFor="let talent of compendiumTalents(); trackBy: trackCompendiumTalent">
            <ng-container *ngTemplateOutlet="compendiumTalentCard; context: { $implicit: talent }"></ng-container>
          </ng-container>
        </div>
        <ng-template #compendiumTalentCard let-talent>
          <button type="button" (click)="toggleCompendiumTalent(talent)" [attr.aria-pressed]="isCompendiumTalentSelected(talent)" [class]="isCompendiumTalentSelected(talent) ? 'flex min-w-0 gap-3 rounded-xl border border-amber-600 bg-amber-950/20 p-3 text-left transition hover:bg-amber-950/30' : 'flex min-w-0 gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-left transition hover:border-zinc-600 hover:bg-zinc-900'">
            <div class="relative h-20 w-20 shrink-0 rounded-xl border border-zinc-700 bg-zinc-950 p-2">
              <img *ngIf="$any(talent).iconUrl" [src]="$any(talent).iconUrl" class="h-full w-full object-contain" alt="">
              <span class="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full border border-zinc-600 bg-zinc-950 p-1 shadow-lg">
                <img *ngIf="$any(talent).classIconUrl" [src]="$any(talent).classIconUrl" class="h-full w-full object-contain" [alt]="$any(talent).className">
              </span>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-start gap-2">
                <h2 class="min-w-0 font-semibold leading-tight text-zinc-100">
                  {{ $any(talent).englishName || $any(talent).name || 'Unknown talent' }}<span *ngIf="isCompendiumTalentSelected(talent)" class="ml-1.5 text-amber-400" aria-label="Pinned">📌</span>
                </h2>
                <span class="ml-auto shrink-0 font-mono text-xs text-zinc-300 opacity-50">{{ compendiumRank() }}/15</span>
              </div>
              <p class="mt-1 text-xs font-medium text-amber-400">{{ $any(talent).className }}</p>
              <p class="mt-2 whitespace-pre-line text-xs leading-relaxed text-zinc-400">{{ $any(talent).displayDescription || 'No description available.' }}</p>
            </div>
          </button>
        </ng-template>
        <ng-template #noCompendiumTalents><p class="rounded-xl border border-zinc-800 bg-zinc-950 py-12 text-center text-sm text-zinc-600">No talents match this search.</p></ng-template>
      </section>

      <section *ngIf="selectedPageTab() === 'codex'" aria-label="Item Codex">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold text-zinc-100">Item Codex</h2>
            <p class="text-xs text-zinc-500">Awareness and possible Rank 9 attributes from the current game state.</p>
          </div>
          <button type="button" (click)="refreshCodex()" [disabled]="codexLoading() || !state().gameRunning" class="rounded-lg border border-amber-700 bg-amber-950/30 px-3 py-2 text-sm font-medium text-amber-300 hover:bg-amber-950/60 disabled:cursor-not-allowed disabled:opacity-40">Refresh</button>
        </div>
        <div class="grid grid-cols-[10rem_minmax(0,1fr)] gap-4">
          <nav class="space-y-1 rounded-xl border border-zinc-800 bg-zinc-950 p-2" aria-label="Codex rarity">
            <button type="button" *ngFor="let rarity of codexRarities" (click)="selectCodexRarity(rarity.key)" [attr.aria-pressed]="selectedCodexRarity() === rarity.key" [class]="selectedCodexRarity() === rarity.key ? 'flex w-full items-center justify-between rounded-lg bg-amber-950/50 px-3 py-2 text-left text-sm font-semibold text-amber-300' : 'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'">
              <span>{{ rarity.label }}</span><span class="text-xs opacity-50">{{ codexRarityCount(rarity.key) }}</span>
            </button>
          </nav>
          <div class="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <p *ngIf="codexLoading() && !codexSnapshot().items.length" class="py-16 text-center text-sm text-zinc-500">Reading the Codex from the game…</p>
            <p *ngIf="codexError()" class="mb-3 rounded-lg border border-rose-900 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">{{ codexError() }}</p>
            <div *ngIf="codexItems().length" class="overflow-x-auto">
              <div class="grid min-w-[720px] grid-cols-10 gap-2">
                <button type="button" *ngFor="let item of codexItems(); trackBy: trackCodexItem" (click)="openCodexItem(item)" [attr.title]="$any(item).englishName || $any(item).name" [attr.aria-label]="codexItemAriaLabel(item)" [class]="'group relative aspect-square rounded-lg border p-1.5 transition hover:brightness-125 ' + rarityIconClass($any(item).rarity)">
                  <img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-full w-full object-contain" alt="">
                  <span class="absolute bottom-1 right-1 rounded bg-black/85 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300">{{ $any(item).awarenessLevel ?? 0 }}</span>
                </button>
              </div>
            </div>
            <p *ngIf="!codexLoading() && !codexItems().length && !codexError()" class="py-16 text-center text-sm text-zinc-600">No {{ selectedCodexRarityLabel() }} Codex items were returned by the game.</p>
          </div>
        </div>
      </section>

      <section *ngIf="selectedPageTab() === 'scanner'" aria-label="Inventory scanner" class="space-y-4">
        <div class="flex items-center gap-2">
          <button type="button" (click)="scanInventory()" [disabled]="scannerScanning() || !state().gameRunning || !hasRunnableScannerFilters()" class="rounded-lg border border-emerald-700 bg-emerald-950/30 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-950/60 disabled:cursor-not-allowed disabled:opacity-40">
            <i class="fa-solid fa-magnifying-glass mr-2" aria-hidden="true"></i>{{ scannerScanning() ? 'Scanning…' : 'Scan inventory' }}
          </button>
          <button type="button" (click)="createScannerFilter()" [disabled]="codexLoading()" class="rounded-lg border border-amber-700 bg-amber-950/30 px-4 py-2 text-sm font-semibold text-amber-300 transition hover:bg-amber-950/60 disabled:opacity-40">
            <i class="fa-solid fa-plus mr-2" aria-hidden="true"></i>Create item filter
          </button>
          <span *ngIf="scannerError()" class="ml-2 text-sm text-rose-300">{{ scannerError() }}</span>
          <div class="ml-auto flex items-center gap-1.5">
            <label class="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">
              <input type="checkbox" [checked]="scannerAutoEnabled()" (change)="setScannerAutoEnabled($event)" class="peer sr-only">
              <span class="relative h-5 w-9 rounded-full border border-zinc-700 bg-zinc-900 transition peer-checked:border-emerald-600 peer-checked:bg-emerald-950"><span class="absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full transition" [class.translate-x-4]="scannerAutoEnabled()" [class.bg-emerald-300]="scannerAutoEnabled()" [class.bg-zinc-500]="!scannerAutoEnabled()"></span></span>
              <span>Auto</span>
            </label>
            <button type="button" (pointerenter)="showScannerAutoTooltip($event)" (pointerleave)="hideTooltips()" aria-label="About automatic inventory scanning" class="flex h-7 w-7 items-center justify-center rounded-full text-zinc-600 hover:text-zinc-300"><i class="fa-solid fa-circle-info text-xs" aria-hidden="true"></i></button>
          </div>
        </div>

        <section *ngIf="scannerHasRun() && scannerMatches().length" class="rounded-2xl border border-emerald-900 bg-emerald-950/10 p-4" aria-label="Scanner matches">
          <div class="mb-3 flex items-center justify-between"><h2 class="font-semibold text-emerald-200">Matches</h2><span class="text-xs text-zinc-500">{{ scannerMatches().length }} item{{ scannerMatches().length === 1 ? '' : 's' }}</span></div>
          <div class="flex flex-wrap gap-3">
            <div *ngFor="let item of scannerMatches(); trackBy: trackScannerMatch" (pointerenter)="showScannerMatchTooltip($event, item)" (pointerleave)="hideTooltips()" class="relative">
              <div [class]="'h-16 w-16 rounded-xl border p-2 shadow-lg transition hover:brightness-125 ' + rarityIconClass($any(item).rarity)"><img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-full w-full object-contain" [alt]="$any(item).englishName || $any(item).name"></div>
            </div>
          </div>
        </section>
        <p *ngIf="scannerHasRun() && !scannerMatches().length && !scannerScanning()" class="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-sm text-zinc-500">No inventory items matched the enabled filters.</p>

        <div *ngIf="scannerFilters().length; else noScannerFilters" class="grid grid-cols-3 gap-3">
          <article *ngFor="let filter of scannerFilters(); let filterIndex = index; trackBy: trackScannerFilter" class="min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 p-3">
            <div class="flex items-center gap-2">
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"><input type="checkbox" [checked]="filter.enabled" (change)="setScannerFilterEnabled(filter.id, $event)" class="h-4 w-4 accent-amber-500"><span class="truncate text-sm font-semibold text-zinc-200">Item filter {{ filterIndex + 1 }}</span></label>
              <button type="button" (click)="editScannerFilter(filter.id)" aria-label="Edit filter" class="h-8 w-8 rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><i class="fa-solid fa-pen"></i></button>
              <button type="button" (click)="deleteScannerFilter(filter.id)" aria-label="Delete filter" class="h-8 w-8 rounded-lg text-zinc-600 hover:bg-rose-950/50 hover:text-rose-300"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="mt-3 flex min-h-12 flex-wrap gap-1.5">
              <div *ngFor="let item of scannerFilterItems(filter); trackBy: trackCodexItem" [class]="'h-11 w-11 rounded-lg border p-1 ' + rarityIconClass($any(item).rarity)" [attr.title]="$any(item).englishName || $any(item).name"><img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-full w-full object-contain" alt=""></div>
              <span *ngIf="!filter.itemKeys.length" class="self-center text-xs text-zinc-600">No items selected</span>
            </div>
            <div class="mt-3 border-t border-zinc-800 pt-3"><div class="mb-2 flex items-center justify-between gap-2"><p class="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Required attributes</p><span *ngIf="filter.statIds.length" class="text-[10px] text-zinc-600">At least {{ filter.minimumAttributeMatches }} of {{ filter.statIds.length }}</span></div><div class="flex flex-wrap gap-1.5"><span *ngFor="let stat of scannerFilterStats(filter); trackBy: trackCodexStat" class="rounded-md bg-zinc-900 px-2 py-1 text-xs text-zinc-400">{{ scannerStatTitle(stat) }}</span><span *ngIf="!filter.statIds.length" class="text-xs text-zinc-600">Any attributes</span></div></div>
          </article>
        </div>
        <ng-template #noScannerFilters><div class="rounded-xl border border-dashed border-zinc-800 py-16 text-center"><i class="fa-solid fa-filter mb-3 text-2xl text-zinc-700"></i><p class="text-sm text-zinc-500">Create an item filter to start scanning the inventory.</p></div></ng-template>
      </section>
      </div>

      <div *ngIf="selectedCodexItem() as item" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" (click)="closeCodexItem()">
        <section role="dialog" aria-modal="true" [attr.aria-label]="($any(item).englishName || $any(item).name || 'Codex item') + ' possible attributes'" class="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl" (click)="$event.stopPropagation()">
          <header class="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-800 p-5">
            <div class="flex min-w-0 items-center gap-3">
              <div [class]="'h-16 w-16 shrink-0 rounded-xl border p-2 ' + rarityIconClass($any(item).rarity)"><img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-full w-full object-contain" alt=""></div>
              <div class="min-w-0">
                <h2 class="truncate text-xl font-semibold text-zinc-100">{{ $any(item).englishName || $any(item).name || 'Unknown item' }}</h2>
                <p class="mt-1 text-sm text-amber-300">{{ $any(item).rarityLabel }} · {{ $any(item).partName || 'Equipment' }}<span *ngIf="$any(item).partName === 'Weapon' && $any(item).subtypeName"> · {{ $any(item).subtypeName }}</span></p>
                <p class="mt-1 text-xs text-zinc-500">Codex awareness {{ $any(item).awarenessLevel ?? 0 }}</p>
              </div>
            </div>
            <button type="button" (click)="closeCodexItem()" class="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-white">Close</button>
          </header>
          <div class="shrink-0 border-b border-zinc-800 px-5 py-3">
            <input #codexAttributeSearchInput type="search" aria-label="Search possible attributes" placeholder="Search attributes…" [value]="codexAttributeSearch()" (input)="setCodexAttributeSearch($event)" class="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-amber-500" />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-5">
            <div *ngIf="filteredCodexStats().length; else noCodexStats" class="space-y-2">
              <div *ngFor="let stat of filteredCodexStats(); trackBy: trackCodexStat" [class]="isCodexStatExcluded(item, stat) ? 'flex items-center gap-3 rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2.5' : 'flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2.5'">
                <span class="shrink-0 rounded bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-500">9</span>
                <p class="min-w-0 flex-1 whitespace-pre-line text-sm text-zinc-200">{{ codexStatText(stat) }}</p>
                <span *ngIf="isCodexStatExcluded(item, stat)" class="shrink-0 text-xs font-semibold uppercase tracking-wide text-rose-300">Excluded</span>
              </div>
            </div>
            <ng-template #noCodexStats><p class="py-10 text-center text-sm text-zinc-600">{{ selectedCodexStats().length ? 'No attributes match this search.' : 'The game returned no possible attributes for this item.' }}</p></ng-template>
          </div>
        </section>
      </div>

      <div *ngIf="editingScannerFilter() as filter" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" (click)="closeScannerFilter()">
        <section role="dialog" aria-modal="true" aria-label="Edit item filter" class="flex h-[90vh] max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl" (click)="$event.stopPropagation()">
          <header class="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-4"><div><h2 class="text-xl font-semibold text-zinc-100">Item filter</h2><p class="mt-1 text-xs text-zinc-500">Changes are saved automatically. Right-click selected items or attributes to remove them.</p></div><button type="button" (click)="closeScannerFilter()" class="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-white">Close</button></header>
          <div class="grid min-h-0 flex-1 grid-rows-[minmax(15rem,0.9fr)_minmax(19rem,1.1fr)] gap-4 overflow-hidden p-5">
            <div class="grid min-h-0 grid-cols-2 gap-4">
            <section class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
              <div class="shrink-0 border-b border-zinc-800 p-3">
                <div class="mb-3"><h3 class="font-semibold text-zinc-200">Items</h3><p class="text-xs text-zinc-600">{{ scannerPrimaryTypeLabel() }}</p></div>
                <input type="search" aria-label="Search items" placeholder="Search all items…" [value]="scannerItemSearch()" (input)="setScannerItemSearch($event)" class="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500">
              </div>
              <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                <div class="grid grid-cols-10 gap-2">
                  <button type="button" *ngFor="let item of scannerPickerItems(); trackBy: trackCodexItem" (click)="toggleScannerItem(item)" (contextmenu)="removeScannerPickerItem($event, item)" [attr.aria-pressed]="scannerItemSelected(item)" [attr.aria-label]="($any(item).englishName || $any(item).name) + ', ' + scannerRarityLabel($any(item).rarity)" [attr.title]="($any(item).englishName || $any(item).name) + (scannerItemSelected(item) ? ' — click or right-click to unselect' : '')" [class]="'relative aspect-square rounded-lg border p-1.5 transition hover:brightness-125 ' + rarityIconClass($any(item).rarity) + (scannerItemSelected(item) ? ' ring-2 ring-emerald-400 ring-offset-1 ring-offset-zinc-950' : '')"><img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-full w-full object-contain" alt=""><i *ngIf="scannerItemSelected(item)" class="fa-solid fa-check absolute right-1 top-1 rounded-full bg-black/80 p-1 text-[9px] text-emerald-300"></i></button>
                </div>
                <p *ngIf="!scannerPickerItems().length" class="py-10 text-center text-sm text-zinc-600">No items match this search and type.</p>
              </div>
            </section>
            <section class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
              <div class="shrink-0 border-b border-zinc-800 p-3"><h3 class="font-semibold text-zinc-200">Options</h3><p class="text-xs text-zinc-600">Control how strictly the selected attributes are matched.</p></div>
              <div class="flex min-h-0 flex-1 items-start p-4">
                <label class="flex w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-300">
                  <span>Must match at least</span>
                  <input type="number" min="1" [max]="filter.statIds.length" [value]="filter.minimumAttributeMatches" (input)="setScannerMinimumAttributeMatches($event)" [disabled]="!filter.statIds.length" aria-label="Minimum selected attributes to match" class="rank-input h-8 w-14 rounded-md border border-zinc-700 bg-zinc-900 text-center font-mono font-semibold text-amber-300 outline-none focus:border-amber-500 disabled:cursor-not-allowed disabled:opacity-40">
                  <span class="min-w-0">selected attribute{{ filter.statIds.length === 1 ? '' : 's' }}.</span>
                </label>
              </div>
            </section>
            </div>

            <section class="grid min-h-0 grid-cols-2 gap-4">
              <div class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
                <div class="shrink-0 border-b border-zinc-800 p-3"><h3 class="mb-2 font-semibold text-zinc-200">Available attributes</h3><input type="search" aria-label="Search available attributes" placeholder="Search available attributes…" [value]="scannerAvailableStatSearch()" (input)="setScannerAvailableStatSearch($event)" class="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"></div>
                <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-3">
                  <button type="button" *ngFor="let stat of scannerAvailableStats(); trackBy: trackCodexStat" (click)="addScannerStat(stat)" (pointerenter)="showScannerDisabledTooltip($event, stat)" (pointerleave)="hideTooltips()" [attr.aria-disabled]="scannerStatSelected(stat) || scannerDisabledItems(stat).length > 0" [class]="scannerDisabledItems(stat).length ? 'relative flex w-full cursor-not-allowed items-center gap-2 rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-left text-sm text-rose-300' : scannerStatSelected(stat) ? 'flex w-full cursor-not-allowed items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-left text-sm text-zinc-300 opacity-30' : 'flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-left text-sm text-zinc-300 hover:border-amber-800 hover:bg-zinc-900'">
                    <span class="min-w-0 flex-1">{{ codexStatText(stat) }}</span>
                    <span *ngIf="scannerDisabledItems(stat).length" class="relative shrink-0"><i class="fa-solid fa-triangle-exclamation text-rose-400"></i></span>
                  </button>
                  <p *ngIf="!scannerAnchorItem()" class="py-8 text-center text-sm text-zinc-600">Select an item to choose its primary type.</p>
                </div>
              </div>
              <div class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
                <div class="shrink-0 border-b border-zinc-800 p-3"><h3 class="mb-2 font-semibold text-zinc-200">Selected attributes</h3><input type="search" aria-label="Search selected attributes" placeholder="Search selected attributes…" [value]="scannerSelectedStatSearch()" (input)="setScannerSelectedStatSearch($event)" class="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"></div>
                <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-3">
                  <div *ngFor="let stat of scannerSelectedStats(); trackBy: trackCodexStat" (contextmenu)="removeScannerStat($event, $any(stat).id)" class="flex w-full items-center gap-2 rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-rose-950/30" [attr.title]="'Right-click to remove ' + scannerStatTitle(stat)"><span class="min-w-0 flex-1">{{ codexStatText(stat) }}</span><button type="button" (click)="removeScannerStat($event, $any(stat).id)" [attr.aria-label]="'Remove ' + scannerStatTitle(stat)" class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-600 hover:bg-rose-950 hover:text-rose-300"><i class="fa-solid fa-xmark"></i></button></div>
                  <p *ngIf="!scannerSelectedStats().length" class="py-8 text-center text-sm text-zinc-600">No required attributes selected.</p>
                </div>
              </div>
            </section>
          </div>
        </section>
      </div>

      <div id="scanner-tooltip" *ngIf="scannerTooltip() as tooltip" role="tooltip" class="pointer-events-none fixed left-0 top-0 z-[80] w-80 rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-left shadow-2xl shadow-black/70 will-change-transform">
        <ng-container *ngIf="$any(tooltip).kind === 'match'; else scannerNonMatchTooltip">
          <ng-container *ngIf="$any(tooltip).item as item">
            <div class="flex items-start gap-3"><div [class]="'h-12 w-12 shrink-0 rounded-lg border p-1.5 ' + rarityIconClass($any(item).rarity)"><img *ngIf="$any(item).iconUrl" [src]="$any(item).iconUrl" class="h-full w-full object-contain" alt=""></div><div><h3 class="font-semibold text-zinc-100">{{ $any(item).englishName || $any(item).name }}</h3><p class="text-xs text-amber-300">{{ $any(item).qualityName || scannerRarityLabel($any(item).rarity) }} · Level {{ $any(item).level ?? '?' }} · {{ $any(item).partName || 'Equipment' }}</p></div></div>
            <div class="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2 text-[10px] text-zinc-500"><span>Forge <b class="text-zinc-300">+{{ $any(item).forgeLevel ?? 0 }}</b></span><span>Main <b class="text-zinc-300">{{ $any(item).mainAttributeValue ?? 0 }}</b></span><span>Slots <b class="text-zinc-300">{{ $any(item).slotCount ?? 0 }}</b></span></div>
            <div class="mt-2 space-y-1 border-t border-zinc-800 pt-2"><p *ngFor="let stat of $any(item).affixes; trackBy: trackInventoryAffix" class="whitespace-pre-line text-xs text-zinc-300"><span class="mr-1 text-zinc-600">{{ $any(stat).rank ?? '?' }}</span>{{ inventoryAffixText($any(stat)) }}</p></div>
            <p class="mt-2 text-[10px] text-zinc-600">Matched {{ $any(item)._matchedFilterIds.length }} enabled filter{{ $any(item)._matchedFilterIds.length === 1 ? '' : 's' }}</p>
          </ng-container>
        </ng-container>
        <ng-template #scannerNonMatchTooltip>
          <ng-container *ngIf="$any(tooltip).kind === 'disabled'; else scannerAutoTooltip"><strong class="block text-sm text-rose-300">Disabled for item(s):</strong><span class="mt-1 block text-xs text-zinc-300" *ngFor="let item of $any(tooltip).items">{{ $any(item).englishName || $any(item).name }} ({{ scannerRarityLabel($any(item).rarity) }})</span></ng-container>
          <ng-template #scannerAutoTooltip><p class="text-xs leading-relaxed text-zinc-300">When Auto is enabled, each new item added to the inventory is compared against the enabled filters.</p></ng-template>
        </ng-template>
      </div>

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
            <button type="button" role="tab" (click)="selectHeroTab('talents')" [attr.aria-selected]="selectedHeroTab() === 'talents'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedHeroTab() === 'talents' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Talents</button>
            <button type="button" role="tab" (click)="selectHeroTab('stats')" [attr.aria-selected]="selectedHeroTab() === 'stats'" class="border-b-2 px-4 py-2 text-sm font-medium" [class]="selectedHeroTab() === 'stats' ? 'border-amber-400 text-amber-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'">Stats</button>
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
            <div class="flex w-24 flex-col items-center" [attr.data-talent-id]="$any(talent).id" (pointerenter)="showTalentTooltip($event, $any(talent))" (pointerleave)="hideTooltips()">
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
            <section class="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-3" aria-label="Combat stats timeline">
              <div class="relative h-10">
                <div class="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-zinc-700"></div>
                <button *ngFor="let entry of timelineEntries(); let index = index; trackBy: trackTimelineEntry" type="button" (click)="selectTimelineEntry(entry.id)" [style.left.%]="timelinePosition(index)" [attr.aria-label]="timelineEntryLabel(entry, index)" class="absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 p-0 leading-none shadow-lg transition" [class]="selectedTimelineId() === entry.id ? 'border-amber-300 bg-amber-500 text-zinc-950' : 'border-zinc-500 bg-zinc-800 text-zinc-300 hover:border-amber-500'">
                  <span class="text-[10px] font-bold">{{ index + 1 }}</span>
                </button>
              </div>
            </section>
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-2">
                <button *ngFor="let effect of combatEffects(); trackBy: trackEffect" type="button" [attr.data-effect-key]="effectKey($any(effect))" (pointerenter)="showEffectTooltip($event, $any(effect))" (pointerleave)="hideTooltips()" class="relative h-9 w-9 rounded-lg border bg-zinc-950 p-1" [class]="effectBorderClass($any(effect))" [attr.aria-label]="effectTitle($any(effect))">
                  <img *ngIf="effectIconUrl($any(effect)) as effectIcon" [src]="effectIcon" class="h-full w-full object-contain" alt="">
                  <span *ngIf="$any(effect).stacks > 1" class="absolute -bottom-1.5 -right-1.5 min-w-4 rounded-full border border-zinc-700 bg-zinc-950 px-1 text-center text-[9px] font-bold text-zinc-100">{{ $any(effect).stacks }}</span>
                </button>
                <span *ngIf="!hasCombatEffects()" class="text-xs text-zinc-600">No active effects captured</span>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <button type="button" (click)="moveTimelineSelection(-1)" [disabled]="!hasPreviousTimelineEntry()" aria-label="Previous timeline snapshot" title="Previous snapshot" class="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">←</button>
                <button type="button" (click)="moveTimelineSelection(1)" [disabled]="!hasNextTimelineEntry()" aria-label="Next timeline snapshot" title="Next snapshot" class="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">→</button>
                <button type="button" (click)="clearTimeline()" [disabled]="!timelineEntries().length" class="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">Clear</button>
                <button type="button" (click)="toggleRecording()" [disabled]="(refreshing() && !recording()) || (!recording() && isSelectedHeroDead())" class="rounded-lg border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50" [class]="recording() ? 'border-rose-700 bg-rose-950/50 text-rose-300' : 'border-emerald-800 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-950'">{{ recording() ? 'Stop' : 'Record' }}</button>
                <button type="button" (click)="refreshHeroes(true)" [disabled]="refreshing() || recording()" class="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-300 hover:bg-amber-950 disabled:opacity-50">Refresh</button>
              </div>
            </div>
            <div class="grid gap-4 md:grid-cols-2">
              <section class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 class="mb-3 text-center text-sm font-semibold text-zinc-200">Current hero stats</h3>
                <div *ngIf="heroStats($any(hero), false).length; else noCurrentStats" class="divide-y divide-zinc-800">
                  <div *ngFor="let stat of heroStats($any(hero), false); trackBy: trackStat" [attr.data-stat-key]="statKey(stat, false)" (pointerenter)="showStatTooltip($event, $any(stat))" (pointerleave)="hideTooltips()" class="flex items-center justify-between gap-4 px-2 py-2 text-sm hover:bg-zinc-800/60">
                    <span class="min-w-0 truncate text-zinc-400">{{ statName($any(stat)) }}</span>
                    <span class="shrink-0 font-mono text-zinc-100">{{ statListValue($any(stat)) }}</span>
                  </div>
                </div>
                <ng-template #noCurrentStats><p class="py-8 text-center text-sm text-zinc-600">Refresh to capture hero stats.</p></ng-template>
              </section>
              <section class="rounded-xl border border-rose-950 bg-rose-950/10 p-4">
                <h3 class="mb-3 text-center text-sm font-semibold text-rose-200">Live combat stats<span *ngIf="selectedTimelineEntry() as entry" class="ml-2 font-normal text-rose-400/60">{{ entry.capturedAt | date:'HH:mm:ss' }}</span></h3>
                <div *ngIf="heroStats($any(hero), true).length; else noCombatStats" class="divide-y divide-zinc-800">
                  <div *ngFor="let stat of heroStats($any(hero), true); trackBy: trackStat" [attr.data-stat-key]="statKey(stat, true)" (pointerenter)="showStatTooltip($event, $any(stat))" (pointerleave)="hideTooltips()" class="flex items-center justify-between gap-4 px-2 py-2 text-sm hover:bg-zinc-800/60">
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
          <div id="effect-tooltip" *ngIf="hoveredEffect() as effect" class="pointer-events-none fixed left-0 top-0 z-[70] w-80 rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-left shadow-2xl will-change-transform">
            <div class="flex items-start gap-3">
              <img *ngIf="effectIconUrl($any(effect)) as effectIcon" [src]="effectIcon" class="h-10 w-10 shrink-0 rounded-md bg-zinc-900 object-contain p-1" alt="">
              <div class="min-w-0"><p class="font-medium text-amber-200">{{ effectTitle($any(effect)) }}</p><p class="mt-0.5 text-xs text-zinc-400">{{ $any(effect).type || 'Effect' }}<span *ngIf="$any(effect).stacks > 1"> · {{ $any(effect).stacks }} stacks</span></p></div>
            </div>
            <p *ngIf="$any(effect).englishDescription || $any(effect).description" class="mt-3 text-xs leading-relaxed text-zinc-300">{{ $any(effect).englishDescription || $any(effect).description }}</p>
            <div class="mt-3 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-400">
              <p><span class="text-zinc-600">Reported source:</span> {{ effectSourceLabel($any(effect)) }}</p>
              <p *ngIf="effectDuration($any(effect))"><span class="text-zinc-600">Duration:</span> {{ effectDuration($any(effect)) }}</p>
              <p *ngIf="$any(effect).level != null"><span class="text-zinc-600">Level:</span> {{ $any(effect).level }}</p>
              <p class="text-[10px] text-zinc-600">Effect ID {{ $any(effect).id }}</p>
            </div>
          </div>
        </section>
      </div>

    </main>
  `
})
class AppComponent implements OnInit, OnDestroy {
  @ViewChild('pageTabBody') private pageTabBody?: ElementRef<HTMLElement>;

  @ViewChild('codexAttributeSearchInput')
  set codexAttributeSearchElement(element: ElementRef<HTMLInputElement> | undefined) {
    if (!element) return;
    element.nativeElement.focus({ preventScroll: true });
    element.nativeElement.select();
  }

  @ViewChild('mapSearchInput')
  set mapSearchElement(element: ElementRef<HTMLInputElement> | undefined) {
    if (!element) return;
    element.nativeElement.focus({ preventScroll: true });
    element.nativeElement.select();
  }

  readonly battleSlots = [0, 1, 2];
  readonly heroPositions = [0, 1, 2];
  readonly codexRarities: Array<{ key: CodexRarityKey; label: string; quality: number }> = [
    { key: 'rare', label: 'Rare', quality: 3 },
    { key: 'legendary', label: 'Legendary', quality: 4 },
    { key: 'set', label: 'Set', quality: 6 },
    { key: 'unique', label: 'Unique', quality: 8 },
    { key: 'mythic', label: 'Mythic', quality: 5 }
  ];
  readonly selectedPageTab = signal<'battles' | 'compendium' | 'codex' | 'scanner'>('battles');
  readonly mapSelectorSlot = signal<number | null>(null);
  readonly mapSearch = signal('');
  readonly selectedAverageMapKeys = signal<string[]>(['standard:Rift-Star Expanse-15', 'standard:Rift-Star Expanse-15', 'standard:Rift-Star Expanse-15']);
  readonly talentSearch = signal('');
  readonly compendiumRank = signal(1);
  readonly selectedCompendiumTalentIds = signal<ReadonlySet<number>>(new Set<number>());
  readonly codexSnapshot = signal<CodexSnapshot>({ updatedAt: null, items: [], affixPools: [], rarities: [] });
  readonly selectedCodexRarity = signal<CodexRarityKey>('rare');
  readonly selectedCodexItem = signal<any | null>(null);
  readonly codexAttributeSearch = signal('');
  readonly codexLoading = signal(false);
  readonly codexError = signal<string | null>(null);
  readonly scannerFilters = signal<ScannerFilter[]>([]);
  readonly editingScannerFilterId = signal<string | null>(null);
  readonly scannerItemSearch = signal('');
  readonly scannerAvailableStatSearch = signal('');
  readonly scannerSelectedStatSearch = signal('');
  readonly scannerScanning = signal(false);
  readonly scannerHasRun = signal(false);
  readonly scannerMatches = signal<ScannerMatch[]>([]);
  readonly scannerError = signal<string | null>(null);
  readonly scannerAutoEnabled = signal(false);
  readonly scannerTooltip = signal<{ kind: 'match'; item: ScannerMatch } | { kind: 'disabled'; items: any[] } | { kind: 'auto' } | null>(null);
  readonly catalogs = signal<Record<string, any[]>>({});
  readonly selectedHero = signal<any | null>(null);
  readonly selectedHeroTab = signal<'talents' | 'stats'>('talents');
  readonly hoveredTalent = signal<any | null>(null);
  readonly hoveredStat = signal<any | null>(null);
  readonly hoveredEffect = signal<any | null>(null);
  readonly refreshing = signal(false);
  readonly recording = signal(false);
  readonly timelineEntries = signal<CombatTimelineEntry[]>([]);
  readonly selectedTimelineId = signal<number | null>(null);
  readonly compendiumTalentEntries = computed<any[]>(() => {
    const rank = this.compendiumRank();
    const jobs = new Map((this.catalogs()['jobs'] || []).map((job: any) => [Number(job?.id), job]));
    return (this.catalogs()['talents'] || []).filter((talent: any) => Number(talent?.masteryId) > 0 && Number(talent?.skillId) <= 0).map((talent: any) => {
      const jobId = Number(talent?.jobId);
      const job = jobs.get(jobId);
      const ranked = Array.isArray(talent?.rankDescriptions) ? talent.rankDescriptions[rank - 1] : null;
      const displayDescription = this.plainGameText(ranked || talent?.englishDescription || talent?.description || '');
      const className = this.plainGameText(job?.englishName || job?.name || `Class ${jobId}`);
      const searchable = this.plainGameText(JSON.stringify({ ...talent, className, selectedRank: rank, displayDescription })).toLocaleLowerCase('en-US');
      return {
        ...talent,
        className,
        classIconUrl: job?.iconUrl || this.classIconUrl(jobId),
        displayDescription,
        _searchable: searchable
      };
    }).sort((left: any, right: any) => Number(left?.jobId) - Number(right?.jobId)
        || Number(left?.floor) - Number(right?.floor)
        || Number(left?.id) - Number(right?.id));
  });
  readonly compendiumTalents = computed<any[]>(() => {
    const search = this.talentSearch().trim().toLocaleLowerCase('en-US');
    return this.compendiumTalentEntries().filter((talent: any) => !search || talent._searchable.includes(search));
  });
  readonly selectedCompendiumTalents = computed<any[]>(() => {
    const selectedIds = this.selectedCompendiumTalentIds();
    return this.compendiumTalentEntries().filter((talent: any) => selectedIds.has(Number(talent?.id)));
  });
  readonly codexItems = computed<any[]>(() => this.codexSnapshot().items
    .filter((item: any) => item?.rarity === this.selectedCodexRarity())
    .sort((left: any, right: any) => Number(left?.part) - Number(right?.part)
      || Number(left?.subtype) - Number(right?.subtype)
      || Number(left?.sortIndex) - Number(right?.sortIndex)
      || Number(left?.id) - Number(right?.id)));
  readonly selectedCodexStats = computed<any[]>(() => {
    const item = this.selectedCodexItem();
    if (!item) return [];
    return this.codexSnapshot().affixPools.find(pool => Number(pool?.id) === Number(item?.affixPoolId))?.stats || [];
  });
  readonly filteredCodexStats = computed<any[]>(() => {
    const search = this.codexAttributeSearch().trim().toLocaleLowerCase('en-US');
    return this.selectedCodexStats().filter(stat => !search || `${this.codexStatText(stat)} ${stat?.qualityName || ''}`.toLocaleLowerCase('en-US').includes(search));
  });
  readonly editingScannerFilter = computed<ScannerFilter | null>(() => this.scannerFilters().find(filter => filter.id === this.editingScannerFilterId()) || null);
  readonly editingScannerItems = computed<any[]>(() => {
    const keys = new Set(this.editingScannerFilter()?.itemKeys || []);
    return this.codexSnapshot().items.filter((item: any) => keys.has(this.codexItemKey(item)));
  });
  readonly scannerAnchorItem = computed<any | null>(() => {
    const key = this.editingScannerFilter()?.anchorItemKey;
    return key ? this.codexSnapshot().items.find((item: any) => this.codexItemKey(item) === key) || null : null;
  });
  readonly scannerPickerItems = computed<any[]>(() => {
    const search = this.scannerItemSearch().trim().toLocaleLowerCase('en-US');
    const part = Number(this.scannerAnchorItem()?.part);
    return this.codexSnapshot().items
      .filter((item: any) => (!part || Number(item?.part) === part)
        && (!search || `${item?.englishName || item?.name || ''} ${item?.rarityLabel || item?.rarity || ''} ${item?.partName || ''} ${item?.subtypeName || ''}`.toLocaleLowerCase('en-US').includes(search)))
      .sort((left: any, right: any) => Number(left?.part) - Number(right?.part) || Number(left?.subtype) - Number(right?.subtype) || Number(left?.sortIndex) - Number(right?.sortIndex) || Number(left?.id) - Number(right?.id));
  });
  readonly scannerPrimaryStats = computed<any[]>(() => {
    const part = Number(this.scannerAnchorItem()?.part);
    if (!part) return [];
    const pools = new Map(this.codexSnapshot().affixPools.map(pool => [Number(pool.id), pool.stats || []]));
    const stats = new Map<number, any>();
    const anchor = this.scannerAnchorItem();
    const items = [anchor, ...this.codexSnapshot().items.filter((entry: any) => entry !== anchor && Number(entry?.part) === part)];
    for (const item of items) {
      for (const stat of pools.get(Number(item?.affixPoolId)) || []) if (!stats.has(Number(stat?.id))) stats.set(Number(stat?.id), stat);
    }
    return [...stats.values()].sort((left: any, right: any) => this.scannerStatTitle(left).localeCompare(this.scannerStatTitle(right), 'en-US', { numeric: true }));
  });
  readonly scannerAvailableStats = computed<any[]>(() => {
    const search = this.scannerAvailableStatSearch().trim().toLocaleLowerCase('en-US');
    return this.scannerPrimaryStats().filter(stat => !search || `${this.codexStatText(stat)} ${stat?.qualityName || ''}`.toLocaleLowerCase('en-US').includes(search));
  });
  readonly scannerSelectedStats = computed<any[]>(() => {
    const ids = new Set(this.editingScannerFilter()?.statIds || []);
    const search = this.scannerSelectedStatSearch().trim().toLocaleLowerCase('en-US');
    return this.scannerPrimaryStats().filter(stat => ids.has(Number(stat?.id)) && (!search || this.codexStatText(stat).toLocaleLowerCase('en-US').includes(search)));
  });
  readonly combatEffects = computed<any[]>(() => {
    const selected = this.selectedTimelineEntry();
    const hero = this.selectedHero();
    const source = selected ? selected.effects : (Array.isArray(hero?.combatEffects) ? hero.combatEffects : []);
    const effects = source.map((effect: any, index: number) => ({
      ...effect,
      _uiKey: `${effect?.definitionId ?? effect?.id ?? 'unknown'}:${effect?.runtimeId ?? 'unknown'}:${effect?.sourceHeroId ?? effect?.sourceName ?? 'unknown'}:${effect?.sourceSkillId ?? effect?.originName ?? 'unknown'}:${effect?.level ?? 'unknown'}:${index}`
    }));
    return [
      ...effects.filter((effect: any) => effect?.classification === 'buff'),
      ...effects.filter((effect: any) => effect?.classification === 'debuff'),
      ...effects.filter((effect: any) => effect?.classification !== 'buff' && effect?.classification !== 'debuff')
    ];
  });
  readonly hasCombatEffects = computed(() => this.combatEffects().length > 0);
  readonly state = signal<TelemetryState>({ connected: false, gameRunning: false, updatedAt: null, heroes: [], slots: [], resources: [], sanctum: null, inventory: [], battles: [], events: [], catalogs: {} });
  readonly status = signal('Connecting');
  private stream?: EventSource;
  private recordingTimer?: number;
  private recordingDelayResolve?: () => void;
  private captureQueue: Promise<void> = Promise.resolve();
  private recordingSession = 0;
  private recordingBattleSlot: number | null = null;
  private recordingBattleMarker: string | null = null;
  private pendingSnapshot?: { previousTimestamp: string | null; resolve: (state: TelemetryState | null) => void; timeout: number };
  private tooltipFrame?: number;
  private tooltipValidationFrame?: number;
  private activeTooltipId?: string;
  private activeTooltipAnchor?: HTMLElement;
  private catalogRefreshRequested = false;
  private lastInventoryItemAddedTimestamp: string | null = null;
  private scannerAudioContext?: AudioContext;
  private destroyed = false;
  private readonly nativePointerMove = (event: PointerEvent) => {
    if (!this.activeTooltipId || !this.activeTooltipAnchor) return;
    const target = event.target;
    if (!this.activeTooltipAnchor.isConnected || !(target instanceof Node) || !this.activeTooltipAnchor.contains(target)) {
      this.zone.run(() => this.hideTooltips());
      return;
    }
    this.positionTooltip(event, this.activeTooltipId);
  };

  constructor(private readonly zone: NgZone) {}

  async ngOnInit() {
    this.restoreCompendiumPreferences();
    this.zone.runOutsideAngular(() => document.addEventListener('pointermove', this.nativePointerMove, { passive: true }));
    try {
      const [live, catalogs] = await Promise.all([
        fetch('/api/state').then(response => response.json()),
        fetch('/api/catalogs').then(response => response.json())
      ]);
      this.catalogs.set(catalogs);
      this.state.set({ ...live, catalogs });
      this.lastInventoryItemAddedTimestamp = live.inventoryItemAdded?.timestamp || null;
      if (live.gameRunning) void this.refreshTalentCatalogIfNeeded();
    } catch { /* server stream will retry */ }
    this.stream = new EventSource('/api/stream');
    this.stream.onopen = () => this.status.set('Backend connected');
    this.stream.onerror = () => this.status.set('Reconnecting');
    this.stream.onmessage = event => {
      const previousSnapshotTimestamp = this.latestSlotSnapshotTimestamp(this.state());
      const next = { ...JSON.parse(event.data), catalogs: this.catalogs() } as TelemetryState;
      this.state.set(next);
      this.handleInventoryItemAdded(next.inventoryItemAdded || null);
      if (next.gameRunning) void this.refreshTalentCatalogIfNeeded();
      this.scheduleTooltipAnchorValidation();
      if (this.pendingSnapshot && this.latestSlotSnapshotTimestamp(next) !== this.pendingSnapshot.previousTimestamp) {
        window.clearTimeout(this.pendingSnapshot.timeout);
        const resolve = this.pendingSnapshot.resolve;
        this.pendingSnapshot = undefined;
        resolve(next);
      }
      if (this.recording() && this.recordingBattleSlot != null) {
        const latestBattle = this.latestBattleMarker(next, this.recordingBattleSlot);
        if (latestBattle != null && latestBattle !== this.recordingBattleMarker) this.stopRecording();
      }
      const selected = this.selectedHero();
      if (!selected) return;
      const fresh = next.slots.flatMap(slot => slot.heroes as any[]).find(hero => this.heroIdentity(hero) === this.heroIdentity(selected));
      if (fresh && this.latestSlotSnapshotTimestamp(next) !== previousSnapshotTimestamp) {
        this.selectedHero.set(fresh);
        this.scheduleTooltipAnchorValidation();
        if (this.recording() && this.isHeroDead(fresh)) this.stopRecording();
      }
    };
  }
  ngOnDestroy() {
    this.destroyed = true;
    this.stream?.close();
    this.stopRecording();
    if (this.pendingSnapshot) { window.clearTimeout(this.pendingSnapshot.timeout); this.pendingSnapshot.resolve(null); this.pendingSnapshot = undefined; }
    document.removeEventListener('pointermove', this.nativePointerMove);
    if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame);
    if (this.tooltipValidationFrame) cancelAnimationFrame(this.tooltipValidationFrame);
    void this.scannerAudioContext?.close();
  }
  selectPageTab(tab: 'battles' | 'compendium' | 'codex' | 'scanner') {
    const currentTab = this.selectedPageTab();
    const enteringCodex = tab === 'codex' && currentTab !== 'codex';
    const enteringScanner = tab === 'scanner' && currentTab !== 'scanner';
    this.hideTooltips();
    this.selectedPageTab.set(tab);
    if (tab !== currentTab && this.pageTabBody) this.pageTabBody.nativeElement.scrollTop = 0;
    if (enteringCodex) void this.refreshCodex();
    if (enteringScanner) void this.ensureScannerCodex();
  }
  toggleMapSelector(event: Event, slot: number) {
    event.preventDefault();
    event.stopPropagation();
    const opening = this.mapSelectorSlot() !== slot;
    this.mapSearch.set('');
    this.mapSelectorSlot.set(opening ? slot : null);
  }
  setMapSearch(event: Event) { this.mapSearch.set((event.target as HTMLInputElement).value); }
  selectAverageMap(event: Event, slot: number, map: any) {
    event.preventDefault();
    event.stopPropagation();
    const key = String(map?.key || '').trim();
    if (!key) return;
    this.selectedAverageMapKeys.update(current => current.map((value, index) => index === slot ? key : value));
    this.writeLocalStorage(`path-of-idle-stats.battles.average-map.${slot}`, key);
    this.mapSelectorSlot.set(null);
    this.mapSearch.set('');
  }
  averageMaps(slot: number): any[] {
    const byTitle = new Map<string, any>();
    for (const battle of this.slotBattles(slot)) {
      const payload = (battle as any)?.payload;
      const title = this.battlePlaceTitle(payload).trim();
      if (!title || title === 'Unknown place') continue;
      const isTreasure = payload?.isTreasure === true || Number(payload?.chapterSiteType) === 2;
      const key = this.averageMapKey(title, isTreasure);
      byTitle.set(key, { key, title, isTreasure, label: isTreasure ? `${title} (Treasure)` : title });
    }
    return [...byTitle.values()].sort((left, right) => left.title.localeCompare(right.title, 'en-US', { numeric: true, sensitivity: 'base' }));
  }
  filteredAverageMaps(slot: number): any[] {
    const search = this.mapSearch().trim().toLocaleLowerCase('en-US');
    return this.averageMaps(slot).filter(map => !search || String(map?.label || '').toLocaleLowerCase('en-US').includes(search));
  }
  selectedAverageMapLabel(slot: number): string {
    const key = this.normalizeAverageMapKey(this.selectedAverageMapKeys()[slot]);
    return this.averageMaps(slot).find(map => map.key === key)?.label || this.averageMapSelection(key).title;
  }
  isAverageMapSelected(slot: number, map: any): boolean { return this.normalizeAverageMapKey(this.selectedAverageMapKeys()[slot]) === String(map?.key || ''); }
  trackAverageMap(_index: number, map: any): string { return String(map?.key || ''); }
  private averageMapKey(title: string, isTreasure: boolean): string { return `${isTreasure ? 'treasure' : 'standard'}:${title}`; }
  private normalizeAverageMapKey(value: string | null | undefined): string {
    const key = String(value || '').trim();
    if (key.startsWith('standard:') || key.startsWith('treasure:')) return key;
    return this.averageMapKey(key || 'Rift-Star Expanse-15', false);
  }
  private averageMapSelection(value: string): { title: string; isTreasure: boolean } {
    const key = this.normalizeAverageMapKey(value);
    const separator = key.indexOf(':');
    return { title: key.slice(separator + 1), isTreasure: key.startsWith('treasure:') };
  }
  setTalentSearch(event: Event) { this.talentSearch.set((event.target as HTMLInputElement).value); }
  setCompendiumRank(event: Event) {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    this.updateCompendiumRank(value);
  }
  adjustCompendiumRank(offset: -1 | 1) { this.updateCompendiumRank(this.compendiumRank() + offset); }
  isCompendiumTalentSelected(talent: any): boolean { return this.selectedCompendiumTalentIds().has(Number(talent?.id)); }
  toggleCompendiumTalent(talent: any) {
    const id = Number(talent?.id);
    if (!Number.isFinite(id)) return;
    const selected = new Set(this.selectedCompendiumTalentIds());
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    this.selectedCompendiumTalentIds.set(selected);
    this.writeLocalStorage('path-of-idle-stats.compendium.selected-talents', JSON.stringify([...selected]));
  }
  trackCompendiumTalent(_index: number, talent: any): number { return Number(talent?.id); }
  selectCodexRarity(rarity: CodexRarityKey) {
    this.selectedCodexRarity.set(rarity);
    this.writeLocalStorage('path-of-idle-stats.codex.rarity', rarity);
  }
  setCodexAttributeSearch(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.codexAttributeSearch.set(value);
    this.writeLocalStorage('path-of-idle-stats.codex.attribute-search', value);
  }
  selectedCodexRarityLabel(): string { return this.codexRarities.find(rarity => rarity.key === this.selectedCodexRarity())?.label || 'selected'; }
  codexRarityCount(rarity: CodexRarityKey): number { return this.codexSnapshot().items.filter((item: any) => item?.rarity === rarity).length; }
  trackCodexItem(_index: number, item: any): string { return String(item?.key ?? `${item?.rarity}:${item?.id}`); }
  trackCodexStat(_index: number, stat: any): number { return Number(stat?.id); }
  codexItemAriaLabel(item: any): string {
    return `${item?.englishName || item?.name || 'Unknown item'}, awareness ${item?.awarenessLevel ?? 0}`;
  }
  openCodexItem(item: any) { this.selectedCodexItem.set(item); this.hideTooltips(); }
  closeCodexItem() { this.selectedCodexItem.set(null); }
  isCodexStatExcluded(item: any, stat: any): boolean {
    return Array.isArray(item?.excludedAffixIds) && item.excludedAffixIds.map(Number).includes(Number(stat?.id));
  }
  codexStatText(stat: any): string {
    const display = this.plainGameText(stat?.displayDescription || '').replace(/~/g, '-');
    if (display) return display;
    const range = this.plainGameText(stat?.rank9Range || '');
    const english = this.plainGameText(stat?.englishDescription || stat?.displayDescription || stat?.description || 'Unknown attribute');
    if (!range) return english;
    if (/[A-Za-z]/.test(range)) return range;
    if (/\{[^}]+\}/.test(english)) return english.replace(/\{[^}]+\}/, range.replace(/~/g, '-')).replace(/\s*\{[^}]+\}/g, '');
    return `${english} ${range.replace(/~/g, '-')}`.trim();
  }
  rarityIconClass(rarity: unknown): string {
    switch (String(rarity || '').toLocaleLowerCase('en-US')) {
      case 'rare': return 'border-yellow-500/70 bg-yellow-950/70';
      case 'legendary': return 'border-orange-500/70 bg-orange-950/70';
      case 'set': return 'border-emerald-500/70 bg-emerald-950/70';
      case 'unique': return 'border-cyan-400/70 bg-cyan-950/70';
      case 'mythic': return 'border-red-500/70 bg-red-950/70';
      default: return 'border-zinc-700 bg-zinc-900';
    }
  }
  scannerRarityLabel(rarity: unknown): string {
    const key = String(rarity || '').toLocaleLowerCase('en-US');
    return this.codexRarities.find(entry => entry.key === key)?.label || key || 'Unknown';
  }
  scannerPrimaryTypeLabel(): string {
    const item = this.scannerAnchorItem();
    return item ? `${item?.partName || 'Equipment'} items only` : 'Select the first item to choose a primary type';
  }
  scannerItemSelected(item: any): boolean { return !!this.editingScannerFilter()?.itemKeys.includes(this.codexItemKey(item)); }
  scannerStatSelected(stat: any): boolean { return !!this.editingScannerFilter()?.statIds.includes(Number(stat?.id)); }
  scannerStatTitle(stat: any): string {
    const text = this.codexStatText(stat);
    return text.replace(/\s+[+-](?=\(?\d).*$/, '').trim() || text;
  }
  scannerDisabledItems(stat: any): any[] {
    const statId = Number(stat?.id);
    const poolStats = new Map(this.codexSnapshot().affixPools.map(pool => [Number(pool.id), new Set((pool.stats || []).map(entry => Number(entry?.id))) ]));
    return this.editingScannerItems().filter((item: any) => this.isCodexStatExcluded(item, stat) || !poolStats.get(Number(item?.affixPoolId))?.has(statId));
  }
  scannerFilterItems(filter: ScannerFilter): any[] {
    const keys = new Set(filter.itemKeys);
    return this.codexSnapshot().items.filter((item: any) => keys.has(this.codexItemKey(item)));
  }
  scannerFilterStats(filter: ScannerFilter): any[] {
    const ids = new Set(filter.statIds);
    const stats = new Map<number, any>();
    const anchor = this.codexSnapshot().items.find((item: any) => this.codexItemKey(item) === filter.anchorItemKey);
    const orderedPools = [
      ...this.codexSnapshot().affixPools.filter(pool => Number(pool.id) === Number(anchor?.affixPoolId)),
      ...this.codexSnapshot().affixPools.filter(pool => Number(pool.id) !== Number(anchor?.affixPoolId))
    ];
    for (const pool of orderedPools) for (const stat of pool.stats || []) if (ids.has(Number(stat?.id)) && !stats.has(Number(stat?.id))) stats.set(Number(stat?.id), stat);
    return [...stats.values()];
  }
  trackScannerFilter(_index: number, filter: ScannerFilter): string { return filter.id; }
  trackScannerMatch(_index: number, item: ScannerMatch): string { return `${item?.inventoryIndex ?? 'unknown'}:${item?.rarity}:${item?.id}`; }
  trackInventoryAffix(_index: number, stat: any): string { return `${stat?.id ?? 'unknown'}:${stat?.rank ?? 'unknown'}:${_index}`; }
  inventoryAffixText(stat: any): string { return this.plainGameText(stat?.displayDescription || stat?.englishDescription || stat?.description || 'Unknown attribute'); }
  hasRunnableScannerFilters(): boolean { return this.scannerFilters().some(filter => filter.enabled && filter.itemKeys.length > 0); }
  async createScannerFilter() {
    await this.ensureScannerCodex();
    if (!this.codexSnapshot().items.length) return;
    const filter: ScannerFilter = { id: this.newScannerFilterId(), enabled: true, itemKeys: [], anchorItemKey: null, statIds: [], minimumAttributeMatches: 1 };
    this.scannerFilters.update(filters => [...filters, filter]);
    this.invalidateScannerResults();
    this.saveScannerFilters();
    this.editScannerFilter(filter.id);
  }
  editScannerFilter(id: string) {
    if (!this.scannerFilters().some(filter => filter.id === id)) return;
    this.scannerItemSearch.set('');
    this.scannerAvailableStatSearch.set('');
    this.scannerSelectedStatSearch.set('');
    this.editingScannerFilterId.set(id);
    this.hideTooltips();
  }
  closeScannerFilter() { this.editingScannerFilterId.set(null); }
  deleteScannerFilter(id: string) {
    this.scannerFilters.update(filters => filters.filter(filter => filter.id !== id));
    if (this.editingScannerFilterId() === id) this.closeScannerFilter();
    this.invalidateScannerResults();
    this.saveScannerFilters();
  }
  setScannerFilterEnabled(id: string, event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    this.updateScannerFilter(id, filter => ({ ...filter, enabled }));
  }
  setScannerItemSearch(event: Event) { this.scannerItemSearch.set((event.target as HTMLInputElement).value); }
  setScannerAvailableStatSearch(event: Event) { this.scannerAvailableStatSearch.set((event.target as HTMLInputElement).value); }
  setScannerSelectedStatSearch(event: Event) { this.scannerSelectedStatSearch.set((event.target as HTMLInputElement).value); }
  setScannerAutoEnabled(event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    this.scannerAutoEnabled.set(enabled);
    this.writeLocalStorage('path-of-idle-stats.scanner.auto', String(enabled));
    this.lastInventoryItemAddedTimestamp = this.state().inventoryItemAdded?.timestamp || null;
    if (enabled) this.prepareScannerSound();
  }
  setScannerMinimumAttributeMatches(event: Event) {
    const current = this.editingScannerFilter();
    if (!current) return;
    const value = (event.target as HTMLInputElement).valueAsNumber;
    this.updateScannerFilter(current.id, filter => ({ ...filter, minimumAttributeMatches: value }));
  }
  toggleScannerItem(item: any) {
    const current = this.editingScannerFilter();
    if (!current) return;
    const key = this.codexItemKey(item);
    if (current.itemKeys.includes(key)) { this.removeScannerItemByKey(key); return; }
    let itemKeys = current.itemKeys;
    let anchorItemKey = current.anchorItemKey;
    if (!anchorItemKey) {
      const part = Number(item?.part);
      const compatible = new Set(this.codexSnapshot().items.filter((entry: any) => Number(entry?.part) === part).map((entry: any) => this.codexItemKey(entry)));
      itemKeys = itemKeys.filter(existing => compatible.has(existing));
      anchorItemKey = key;
    }
    this.updateScannerFilter(current.id, filter => ({ ...filter, anchorItemKey, itemKeys: [...filter.itemKeys.filter(existing => itemKeys.includes(existing)), key] }));
    this.pruneScannerStats(current.id);
  }
  removeScannerPickerItem(event: Event, item: any) {
    const key = this.codexItemKey(item);
    if (!this.editingScannerFilter()?.itemKeys.includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    this.removeScannerItemByKey(key);
  }
  private removeScannerItemByKey(key: string) {
    const current = this.editingScannerFilter();
    if (!current) return;
    this.updateScannerFilter(current.id, filter => ({ ...filter, itemKeys: filter.itemKeys.filter(itemKey => itemKey !== key), anchorItemKey: filter.anchorItemKey === key ? null : filter.anchorItemKey }));
  }
  addScannerStat(stat: any) {
    const current = this.editingScannerFilter();
    const id = Number(stat?.id);
    if (!current || !Number.isFinite(id) || current.statIds.includes(id) || this.scannerDisabledItems(stat).length) return;
    this.updateScannerFilter(current.id, filter => ({ ...filter, statIds: [...filter.statIds, id] }));
  }
  removeScannerStat(event: Event, id: number) {
    event.preventDefault();
    event.stopPropagation();
    const current = this.editingScannerFilter();
    if (current) this.updateScannerFilter(current.id, filter => ({ ...filter, statIds: filter.statIds.filter(statId => statId !== Number(id)) }));
  }
  async scanInventory() {
    if (this.scannerScanning() || !this.hasRunnableScannerFilters()) return;
    this.prepareScannerSound();
    this.scannerScanning.set(true);
    this.scannerError.set(null);
    const previousTimestamp = this.state().inventoryUpdatedAt || null;
    try {
      const request = await fetch('/api/inventory/refresh', { method: 'POST' });
      if (!request.ok) throw new Error('The backend rejected the inventory request.');
      let live: TelemetryState | null = null;
      for (let attempt = 0; attempt < 60 && !this.destroyed; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 250));
        const candidate = await fetch('/api/state').then(response => response.json()) as TelemetryState;
        if (candidate.inventoryUpdatedAt && candidate.inventoryUpdatedAt !== previousTimestamp) { live = candidate; break; }
      }
      if (!live) throw new Error('The game did not return the inventory in time.');
      this.state.set({ ...live, catalogs: this.catalogs() });
      const enabled = this.scannerFilters().filter(filter => filter.enabled && filter.itemKeys.length);
      const matches = new Map<string, ScannerMatch>();
      for (const item of (live.inventory || []) as any[]) {
        const matching = this.matchingScannerFilters(item, enabled);
        if (!matching.length) continue;
        const key = `${item?.inventoryIndex ?? 'unknown'}:${this.codexItemKey(item)}`;
        matches.set(key, { ...item, _matchedFilterIds: matching.map(filter => filter.id) });
      }
      this.scannerMatches.set([...matches.values()]);
      this.scannerHasRun.set(true);
      if (matches.size) this.playScannerMatchSound();
    } catch (error) {
      this.scannerError.set(error instanceof Error ? error.message : 'Inventory scan failed.');
    } finally { this.scannerScanning.set(false); }
  }
  private async ensureScannerCodex() {
    if (this.codexSnapshot().items.length) return;
    await this.refreshCodex();
    if (!this.codexSnapshot().items.length && !this.codexError()) this.scannerError.set('The game returned no Codex item definitions.');
  }
  private matchingScannerFilters(item: any, candidates = this.scannerFilters().filter(filter => filter.enabled && filter.itemKeys.length)): ScannerFilter[] {
    const itemKey = this.codexItemKey(item);
    const affixIds = new Set((Array.isArray(item?.affixes) ? item.affixes : []).map((affix: any) => Number(affix?.id)));
    return candidates.filter(filter => {
      if (!filter.itemKeys.includes(itemKey)) return false;
      if (!filter.statIds.length) return true;
      const matchedAttributeCount = filter.statIds.reduce((count, id) => count + (affixIds.has(Number(id)) ? 1 : 0), 0);
      return matchedAttributeCount >= filter.minimumAttributeMatches;
    });
  }
  private handleInventoryItemAdded(event: TelemetryEvent | null) {
    const timestamp = event?.timestamp || null;
    if (!timestamp || timestamp === this.lastInventoryItemAddedTimestamp) return;
    this.lastInventoryItemAddedTimestamp = timestamp;
    if (!this.scannerAutoEnabled()) return;
    const item = (event?.payload as any)?.item;
    if (!item) return;
    const matching = this.matchingScannerFilters(item);
    if (!matching.length) return;
    const match: ScannerMatch = { ...item, _matchedFilterIds: matching.map(filter => filter.id) };
    const key = `${item?.inventoryIndex ?? timestamp}:${this.codexItemKey(item)}`;
    this.scannerMatches.update(items => [match, ...items.filter(existing => `${existing?.inventoryIndex ?? 'unknown'}:${this.codexItemKey(existing)}` !== key)]);
    this.scannerHasRun.set(true);
    this.playScannerMatchSound();
  }
  private prepareScannerSound(): AudioContext | undefined {
    const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextConstructor) return undefined;
    this.scannerAudioContext ??= new AudioContextConstructor();
    if (this.scannerAudioContext.state === 'suspended') void this.scannerAudioContext.resume().catch(() => undefined);
    return this.scannerAudioContext;
  }
  private playScannerMatchSound() {
    const context = this.prepareScannerSound();
    if (!context) return;
    const play = () => {
      const baseTime = context.currentTime + 0.015;
      for (const [index, frequency] of [659.25, 783.99].entries()) {
        const start = baseTime + index * 0.075;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.055, start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.3);
      }
    };
    if (context.state === 'running') play(); else void context.resume().then(play).catch(() => undefined);
  }
  private codexItemKey(item: any): string { return String(item?.key || `${item?.rarity}:${item?.id}`); }
  private newScannerFilterId(): string { return `filter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  private updateScannerFilter(id: string, update: (filter: ScannerFilter) => ScannerFilter) {
    this.scannerFilters.update(filters => filters.map(filter => filter.id === id ? this.normalizeScannerFilter(update(filter)) : filter));
    this.invalidateScannerResults();
    this.saveScannerFilters();
  }
  private pruneScannerStats(id: string) {
    const allowed = new Set(this.scannerPrimaryStats().map(stat => Number(stat?.id)));
    this.updateScannerFilter(id, filter => ({ ...filter, statIds: filter.statIds.filter(statId => allowed.has(statId)) }));
  }
  private saveScannerFilters() { this.writeLocalStorage('path-of-idle-stats.scanner.filters', JSON.stringify(this.scannerFilters())); }
  private normalizeScannerFilter(filter: ScannerFilter): ScannerFilter {
    const selectedCount = filter.statIds.length;
    const requested = Number(filter.minimumAttributeMatches);
    const minimumAttributeMatches = selectedCount ? Math.max(1, Math.min(selectedCount, Number.isFinite(requested) ? Math.round(requested) : selectedCount)) : 1;
    return { ...filter, minimumAttributeMatches };
  }
  private invalidateScannerResults() { this.scannerHasRun.set(false); this.scannerMatches.set([]); this.scannerError.set(null); }
  async refreshCodex() {
    if (this.codexLoading()) return;
    if (!this.state().gameRunning) { this.codexError.set('Start the game and enter your save before refreshing the Codex.'); return; }
    this.codexLoading.set(true);
    this.codexError.set(null);
    const previousTimestamp = this.codexSnapshot().updatedAt;
    try {
      const response = await fetch('/api/codex/refresh', { method: 'POST' });
      if (!response.ok) throw new Error('The backend rejected the Codex request.');
      for (let attempt = 0; attempt < 80 && !this.destroyed; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 500));
        const snapshot = await fetch('/api/codex').then(result => {
          if (!result.ok) throw new Error('The backend could not return the Codex snapshot.');
          return result.json();
        }) as CodexSnapshot;
        if (!snapshot?.updatedAt || snapshot.updatedAt === previousTimestamp) continue;
        const normalized: CodexSnapshot = {
          updatedAt: snapshot.updatedAt,
          items: Array.isArray(snapshot.items) ? snapshot.items : [],
          affixPools: Array.isArray(snapshot.affixPools) ? snapshot.affixPools : [],
          rarities: Array.isArray(snapshot.rarities) ? snapshot.rarities : []
        };
        this.codexSnapshot.set(normalized);
        const selectedKey = this.selectedCodexItem()?.key;
        if (selectedKey) this.selectedCodexItem.set(normalized.items.find((item: any) => item?.key === selectedKey) || null);
        return;
      }
      throw new Error('The game did not return a Codex snapshot in time.');
    } catch (error) {
      this.codexError.set(error instanceof Error ? error.message : 'Codex refresh failed.');
    } finally {
      this.codexLoading.set(false);
    }
  }
  private updateCompendiumRank(value: number) {
    const rank = this.clampCompendiumRank(value);
    this.compendiumRank.set(rank);
    this.writeLocalStorage('path-of-idle-stats.compendium.rank', String(rank));
  }
  private restoreCompendiumPreferences() {
    try {
      const storedRank = window.localStorage.getItem('path-of-idle-stats.compendium.rank');
      if (storedRank != null) this.compendiumRank.set(this.clampCompendiumRank(Number(storedRank)));
      const storedTalents = JSON.parse(window.localStorage.getItem('path-of-idle-stats.compendium.selected-talents') || '[]');
      if (Array.isArray(storedTalents)) {
        this.selectedCompendiumTalentIds.set(new Set(storedTalents.map(Number).filter(Number.isFinite)));
      }
      const storedCodexRarity = window.localStorage.getItem('path-of-idle-stats.codex.rarity') as CodexRarityKey | null;
      if (storedCodexRarity && this.codexRarities.some(rarity => rarity.key === storedCodexRarity)) {
        this.selectedCodexRarity.set(storedCodexRarity);
      }
      this.codexAttributeSearch.set(window.localStorage.getItem('path-of-idle-stats.codex.attribute-search') || '');
      this.scannerAutoEnabled.set(window.localStorage.getItem('path-of-idle-stats.scanner.auto') === 'true');
      const storedScannerFilters = JSON.parse(window.localStorage.getItem('path-of-idle-stats.scanner.filters') || '[]');
      if (Array.isArray(storedScannerFilters)) {
        this.scannerFilters.set(storedScannerFilters.filter(filter => filter && typeof filter.id === 'string').map(filter => {
          const statIds = Array.isArray(filter.statIds) ? filter.statIds.map(Number).filter(Number.isFinite) : [];
          const storedMinimum = Number(filter.minimumAttributeMatches);
          return this.normalizeScannerFilter({
            id: filter.id,
            enabled: filter.enabled !== false,
            itemKeys: Array.isArray(filter.itemKeys) ? filter.itemKeys.map(String) : [],
            anchorItemKey: typeof filter.anchorItemKey === 'string' ? filter.anchorItemKey : null,
            statIds,
            minimumAttributeMatches: Number.isFinite(storedMinimum) ? storedMinimum : Math.max(1, statIds.length)
          });
        }));
      }
      this.selectedAverageMapKeys.set(this.battleSlots.map(slot => this.normalizeAverageMapKey(window.localStorage.getItem(`path-of-idle-stats.battles.average-map.${slot}`))));
    } catch { /* localStorage can be unavailable in privacy-restricted contexts */ }
  }
  private writeLocalStorage(key: string, value: string) {
    try { window.localStorage.setItem(key, value); } catch { /* preferences remain in memory */ }
  }
  private clampCompendiumRank(value: number): number { return Number.isFinite(value) ? Math.max(1, Math.min(15, Math.round(value))) : 1; }
  private plainGameText(value: unknown): string {
    return String(value ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
  }
  private talentCatalogReady(catalogs: Record<string, any[]>): boolean {
    const talents = (catalogs['talents'] || []).filter((talent: any) => Number(talent?.masteryId) > 0 && Number(talent?.skillId) <= 0);
    return talents.length > 0 && talents.every((talent: any) => Array.isArray(talent?.rankDescriptions)
      && talent.rankDescriptions.length === 15 && talent.rankDescriptions.some((description: unknown) => String(description || '').trim()));
  }
  private async refreshTalentCatalogIfNeeded() {
    if (this.catalogRefreshRequested || this.talentCatalogReady(this.catalogs())) return;
    this.catalogRefreshRequested = true;
    try {
      const response = await fetch('/api/catalogs/refresh', { method: 'POST' });
      if (!response.ok) return;
      for (let attempt = 0; attempt < 40 && !this.destroyed; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 500));
        const catalogs = await fetch('/api/catalogs').then(result => result.json()) as Record<string, any[]>;
        this.catalogs.set(catalogs);
        this.state.update(current => ({ ...current, catalogs }));
        if (this.talentCatalogReady(catalogs)) return;
      }
    } catch { /* The next page load can request the catalog again. */ }
  }
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
  sanctumFloor(): string {
    const raw = this.state().sanctum?.floor;
    if (raw == null) return '—';
    const floor = Number(raw);
    return Number.isFinite(floor) ? Math.floor(floor).toLocaleString('en-US') : '—';
  }
  sanctumBonus(): string {
    const raw = this.state().sanctum?.resourceBonusRate;
    if (raw == null) return '+—%';
    const bonus = Number(raw) * 100;
    return Number.isFinite(bonus) ? `+${bonus.toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : '+—%';
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
  trackTimelineEntry(_index: number, entry: CombatTimelineEntry): number { return entry.id; }
  timelinePosition(index: number): number {
    const count = this.timelineEntries().length;
    return count <= 1 ? 0 : index * 100 / (count - 1);
  }
  timelineEntryLabel(entry: CombatTimelineEntry, index: number): string { return `Snapshot ${index + 1} at ${new Date(entry.capturedAt).toLocaleTimeString()}`; }
  selectedTimelineEntry(): CombatTimelineEntry | null {
    const id = this.selectedTimelineId();
    return id == null ? null : this.timelineEntries().find(entry => entry.id === id) ?? null;
  }
  selectTimelineEntry(id: number) { this.hideTooltips(); this.selectedTimelineId.set(id); }
  private selectedTimelineIndex(): number {
    const selectedId = this.selectedTimelineId();
    return selectedId == null ? -1 : this.timelineEntries().findIndex(entry => entry.id === selectedId);
  }
  hasPreviousTimelineEntry(): boolean { return this.selectedTimelineIndex() > 0; }
  hasNextTimelineEntry(): boolean {
    const index = this.selectedTimelineIndex();
    return index >= 0 && index < this.timelineEntries().length - 1;
  }
  moveTimelineSelection(offset: -1 | 1) {
    const entries = this.timelineEntries();
    const nextIndex = this.selectedTimelineIndex() + offset;
    if (nextIndex >= 0 && nextIndex < entries.length) this.selectTimelineEntry(entries[nextIndex].id);
  }
  clearTimeline() { this.hideTooltips(); this.timelineEntries.set([]); this.selectedTimelineId.set(null); }
  trackEffect(index: number, effect: any): string { return String(effect?._uiKey ?? `${effect?.id ?? 'unknown'}:${effect?.sourceHeroId ?? effect?.sourceName ?? 'unknown'}:${index}`); }
  effectKey(effect: any): string { return String(effect?._uiKey ?? `${effect?.id ?? 'unknown'}:${effect?.sourceHeroId ?? effect?.sourceName ?? 'unknown'}`); }
  effectTitle(effect: any): string {
    const description = String(effect?.englishDescription || effect?.description || '');
    const stackName = /^1\s+stack(?:\s+of)?\s+(.+)$/i.exec(description.trim())?.[1]?.trim();
    const verifiedOriginTitle = effect?.originVerified && (effect?.type === 'Aura' || effect?.type === 'Buff')
      ? effect?.sourceSkillName || effect?.originName
      : null;
    return String(effect?.englishName || effect?.name || verifiedOriginTitle || stackName || effect?.type || 'Effect');
  }
  effectSourceLabel(effect: any): string {
    const actor = String(effect?.sourceName || '').trim();
    const origin = effect?.originVerified ? String(effect?.sourceSkillName || effect?.originName || '').trim() : '';
    if (origin && actor && origin !== actor) return `${origin} · ${actor}`;
    return origin || actor || 'Unknown';
  }
  effectIconUrl(effect: any): string | null { return effect?.iconUrl ? String(effect.iconUrl) : null; }
  effectBorderClass(effect: any): string {
    return effect?.classification === 'debuff' ? 'border-rose-800 hover:border-rose-400' : effect?.classification === 'buff' ? 'border-emerald-800 hover:border-emerald-400' : 'border-violet-800 hover:border-violet-400';
  }
  effectDuration(effect: any): string {
    const duration = Number(effect?.duration), elapsed = Number(effect?.elapsedDuration);
    if (!Number.isFinite(duration) || duration <= 0) return '';
    const remaining = Number.isFinite(elapsed) ? Math.max(0, duration - elapsed) : duration;
    return `${remaining.toFixed(1)}s remaining / ${duration.toFixed(1)}s`;
  }
  statKey(stat: any, combat: boolean): string { return (combat ? 'combat:' : 'current:') + String(stat?.id ?? stat?.key); }
  heroStats(hero: any, combat: boolean): any[] {
    const currentStats = Array.isArray(hero?.stats) ? hero.stats : null;
    const selectedStats = this.selectedTimelineEntry()?.stats;
    const combatStats = selectedStats ?? hero?.combatStats;
    if (combat && currentStats && Array.isArray(combatStats)) {
      const combatByKey = new Map(combatStats.map((stat: any) => [String(stat?.id ?? stat?.key), stat]));
      return currentStats
        .map((stat: any) => combatByKey.get(String(stat?.id ?? stat?.key)))
        .filter((stat: any) => stat != null);
    }
    const stats = combat ? combatStats : currentStats;
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
  private isHeroDead(hero: any): boolean {
    return hero?.isDead === true || (hero?.currentHealth != null && Number.isFinite(Number(hero.currentHealth)) && Number(hero.currentHealth) <= 0);
  }
  isSelectedHeroDead(): boolean { return this.isHeroDead(this.selectedHero()); }
  selectedMapAverage(slot: number): string {
    const selectedMap = this.averageMapSelection(this.selectedAverageMapKeys()[slot]);
    const durations = this.slotBattles(slot)
      .filter(battle => {
        const payload = (battle as any).payload;
        if (payload?.result !== 'win' || this.battlePlaceTitle(payload) !== selectedMap.title) return false;
        const isTreasure = payload?.isTreasure === true || Number(payload?.chapterSiteType) === 2;
        return isTreasure === selectedMap.isTreasure;
      })
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
  async refreshHeroes(addToTimeline = false) {
    if (addToTimeline) { await this.captureTimelineSnapshot(false, this.recordingSession); return; }
    this.refreshing.set(true);
    try { await fetch('/api/snapshot', { method: 'POST' }); }
    finally { window.setTimeout(() => this.refreshing.set(false), 700); }
  }
  toggleRecording() {
    if (this.recording()) { this.stopRecording(); return; }
    const selected = this.selectedHero();
    if (!selected) return;
    if (this.isHeroDead(selected)) { this.stopRecording(); return; }
    const slot = this.state().slots.find(entry => entry.heroes.some(hero => this.heroIdentity(hero) === this.heroIdentity(selected)))?.battleIndex;
    if (slot == null) return;
    this.recordingSession++;
    const session = this.recordingSession;
    this.recordingBattleSlot = Number(slot);
    this.recordingBattleMarker = this.latestBattleMarker(this.state(), this.recordingBattleSlot);
    this.recording.set(true);
    void this.runRecordingLoop(session);
  }
  private stopRecording() {
    this.recordingSession++;
    this.recording.set(false);
    this.recordingBattleSlot = null;
    this.recordingBattleMarker = null;
    if (this.recordingTimer != null) window.clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
    this.recordingDelayResolve?.();
    this.recordingDelayResolve = undefined;
  }
  private async runRecordingLoop(session: number) {
    while (this.recording() && session === this.recordingSession) {
      const startedAt = Date.now();
      await this.captureTimelineSnapshot(true, session);
      if (!this.recording() || session !== this.recordingSession) return;
      await new Promise<void>(resolve => {
        this.recordingDelayResolve = resolve;
        this.recordingTimer = window.setTimeout(() => {
          this.recordingTimer = undefined;
          this.recordingDelayResolve = undefined;
          resolve();
        }, Math.max(0, 2000 - (Date.now() - startedAt)));
      });
    }
  }
  private captureTimelineSnapshot(recordingCapture: boolean, session: number): Promise<void> {
    const task = this.captureQueue.then(() => this.performTimelineSnapshot(recordingCapture, session)).catch(() => undefined);
    this.captureQueue = task;
    return task;
  }
  private async performTimelineSnapshot(recordingCapture: boolean, session: number) {
    if (recordingCapture && (!this.recording() || session !== this.recordingSession)) return;
    const selected = this.selectedHero();
    if (!selected) return;
    this.refreshing.set(true);
    try {
      const previousSnapshot = this.latestSlotSnapshotTimestamp(this.state());
      const snapshotState = new Promise<TelemetryState | null>(resolve => {
        const timeout = window.setTimeout(() => {
          if (this.pendingSnapshot?.resolve === resolve) this.pendingSnapshot = undefined;
          resolve(null);
        }, 10000);
        this.pendingSnapshot = { previousTimestamp: previousSnapshot, resolve, timeout };
      });
      await fetch('/api/snapshot', { method: 'POST' });
      const live = await snapshotState;
      if (recordingCapture && (!this.recording() || session !== this.recordingSession)) return;
      const hero = live?.slots.flatMap(slot => slot.heroes as any[]).find(candidate => this.heroIdentity(candidate) === this.heroIdentity(selected));
      if (hero && this.isHeroDead(hero)) { if (recordingCapture) this.stopRecording(); return; }
      if (!hero?.inCombat || !Array.isArray(hero?.combatStats)) return;
      const entry: CombatTimelineEntry = {
        id: Date.now(),
        capturedAt: Date.now(),
        stats: hero.combatStats.map((stat: any) => ({ ...stat })),
        effects: (Array.isArray(hero.combatEffects) ? hero.combatEffects : []).map((effect: any) => ({ ...effect }))
      };
      this.hideTooltips();
      this.timelineEntries.update(entries => [...entries, entry]);
      this.selectedTimelineId.set(entry.id);
    } finally {
      this.refreshing.set(false);
    }
  }
  private latestSlotSnapshotTimestamp(state: TelemetryState): string | null {
    return state.snapshotUpdatedAt ?? null;
  }
  private latestBattleMarker(state: TelemetryState, slot: number): string | null {
    const battle = state.battles.find(entry => Number((entry as any).payload?.battleIndex) === slot);
    return battle?.timestamp ?? null;
  }
  battleResultClass(result: unknown) { return String(result).toLowerCase().includes('win') ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'; }
  openHero(hero: any) { this.stopRecording(); this.clearTimeline(); this.selectedHero.set(hero); this.selectedHeroTab.set('talents'); }
  selectHeroTab(tab: 'talents' | 'stats') { this.hideTooltips(); this.selectedHeroTab.set(tab); }
  closeHero() { this.stopRecording(); this.selectedHero.set(null); this.hideTooltips(); }
  async resetSlot(slot: number) {
    const response = await fetch('/api/battles/' + slot, { method: 'DELETE' });
    if (!response.ok) throw new Error('Could not reset battle history');
  }
  showEffectTooltip(event: PointerEvent, effect: any) {
    this.hoveredTalent.set(null); this.hoveredStat.set(null); this.scannerTooltip.set(null); this.hoveredEffect.set(effect);
    this.activateTooltip(event, 'effect-tooltip');
  }
  showStatTooltip(event: PointerEvent, stat: any) {
    this.hoveredTalent.set(null); this.hoveredEffect.set(null); this.scannerTooltip.set(null); this.hoveredStat.set(stat);
    this.activateTooltip(event, 'stat-tooltip');
  }
  showTalentTooltip(event: PointerEvent, talent: any) {
    this.hoveredStat.set(null); this.hoveredEffect.set(null); this.scannerTooltip.set(null); this.hoveredTalent.set(talent);
    this.activateTooltip(event, 'talent-tooltip');
  }
  showScannerMatchTooltip(event: PointerEvent, item: ScannerMatch) {
    this.hoveredTalent.set(null); this.hoveredStat.set(null); this.hoveredEffect.set(null);
    this.scannerTooltip.set({ kind: 'match', item });
    this.activateTooltip(event, 'scanner-tooltip');
  }
  showScannerDisabledTooltip(event: PointerEvent, stat: any) {
    const items = this.scannerDisabledItems(stat);
    if (!items.length) return;
    this.hoveredTalent.set(null); this.hoveredStat.set(null); this.hoveredEffect.set(null);
    this.scannerTooltip.set({ kind: 'disabled', items });
    this.activateTooltip(event, 'scanner-tooltip');
  }
  showScannerAutoTooltip(event: PointerEvent) {
    this.hoveredTalent.set(null); this.hoveredStat.set(null); this.hoveredEffect.set(null);
    this.scannerTooltip.set({ kind: 'auto' });
    this.activateTooltip(event, 'scanner-tooltip');
  }
  @HostListener('document:click')
  closeMapSelector() { this.mapSelectorSlot.set(null); this.mapSearch.set(''); }
  @HostListener('document:keydown.escape')
  closeMapSelectorOnEscape() { this.closeMapSelector(); }
  @HostListener('document:mouseleave')
  @HostListener('window:blur')
  hideTooltips() {
    if (this.tooltipFrame) cancelAnimationFrame(this.tooltipFrame);
    if (this.tooltipValidationFrame) cancelAnimationFrame(this.tooltipValidationFrame);
    this.tooltipFrame = undefined; this.tooltipValidationFrame = undefined;
    this.activeTooltipId = undefined; this.activeTooltipAnchor = undefined;
    this.hoveredTalent.set(null); this.hoveredStat.set(null); this.hoveredEffect.set(null); this.scannerTooltip.set(null);
  }
  private activateTooltip(event: PointerEvent, elementId: string) {
    this.activeTooltipAnchor = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    this.activeTooltipId = elementId;
    this.positionTooltip(event, elementId);
  }
  private scheduleTooltipAnchorValidation() {
    if (!this.activeTooltipAnchor) return;
    if (this.tooltipValidationFrame) cancelAnimationFrame(this.tooltipValidationFrame);
    this.tooltipValidationFrame = requestAnimationFrame(() => {
      this.tooltipValidationFrame = undefined;
      const anchor = this.activeTooltipAnchor;
      if (anchor && (!anchor.isConnected || !anchor.matches(':hover'))) this.zone.run(() => this.hideTooltips());
    });
  }
  private positionTooltip(event: PointerEvent, elementId: string) {
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
