using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using BepInEx;
using BepInEx.Unity.IL2CPP;
using HarmonyLib;
using UnityEngine;

namespace PathOfIdleStats;

[BepInPlugin(PluginGuid, PluginName, PluginVersion)]
public sealed class Plugin : BasePlugin
{
    public const string PluginGuid = "local.pathofidle.stats";
    public const string PluginName = "Path of Idle Stats";
    public const string PluginVersion = "0.7.9";

    private static Plugin? Instance;
    private static readonly object StateLock = new();
    private static readonly Dictionary<nint, EffectOriginRecord> EffectOrigins = new();
    [ThreadStatic] private static object? currentEffectSkill;
    private static readonly Dictionary<int, BattleCapture> Battles = new();
    private static readonly Queue<string> PendingIcons = new();
    private static readonly HashSet<string> KnownIcons = new(StringComparer.OrdinalIgnoreCase);
    private static bool catalogSent;
    private static float nextSnapshotRequestCheck;
    private static float nextHeartbeat;
    private static float nextIconExport;
    private static string? lastAutoUiStatus;
    private static string? stableAutoUiSignature;
    private static float stableAutoUiSince;
    private Harmony? harmony;
    private TelemetryWriter? writer;
    private static Assembly? gameAssembly;

    public override void Load()
    {
        Instance = this;
        writer = new TelemetryWriter(Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats"), Log);
        harmony = new Harmony(PluginGuid);
        Patch("AdvBattleData", "Create", nameof(BattleCreatedPostfix));
        Patch("CombatData", "CreateEnemy", nameof(EnemyCreatedPostfix));
        Patch("ActionData", "OnCastSkill", nameof(ActionCastPostfix));
        PatchOverload("AdvTallyData", "AddData", 5, nameof(TallyDamageAddedPostfix));
        Patch("AbilityCheckData", "CreateByBulletCrit", nameof(BulletCritPostfix));
        Patch("AbilityCheckData", "CreateByBulletDodge", nameof(BulletDodgePostfix));
        Patch("AdvFieldData", "BattleEnd", nameof(BattleEndedPostfix));
        Patch("TableData", "init", nameof(TableReadyPostfix));
        Patch("Root", "Update", nameof(RootUpdatePostfix));
        PatchWithContext("TriggerResultData", "DoAbility", nameof(AbilityResultPrefix), nameof(AbilityResultFinalizer));
        Patch("ComAbilityData", "AddAbility", nameof(AbilityAddedPostfix));
        Patch("AbilityData", "Remove", nameof(AbilityRemovedPrefix));
        Patch("LordBagData", "addItemToBag", nameof(InventoryItemAddedPostfix));
        writer.Enqueue("heartbeat", new { pluginVersion = PluginVersion, mode = "live" });
        Log.LogInfo($"{PluginName} {PluginVersion} loaded with read-only telemetry hooks.");
    }

    private static void TableReadyPostfix() => SafeHook("table-ready", () =>
    {
        EmitCatalogs();
        ReportIconProgress(true);
    });

    private static void RootUpdatePostfix() => SafeHook("snapshot-request", () =>
    {
        var now = Time.realtimeSinceStartup;
        if (now >= nextHeartbeat)
        {
            nextHeartbeat = now + 2f;
            Instance?.writer?.Enqueue("heartbeat", new { pluginVersion = PluginVersion, mode = "live" });
        }
        // Keep a 50 icons/second budget. A small catch-up batch preserves the rate
        // below 50 FPS without allowing a large one-frame export spike.
        if (nextIconExport <= 0f) nextIconExport = now;
        if (now >= nextIconExport)
        {
            var exportCount = Math.Min(3, 1 + Mathf.FloorToInt((now - nextIconExport) / 0.02f));
            nextIconExport += exportCount * 0.02f;
            if (nextIconExport < now - 0.06f) nextIconExport = now + 0.02f;
            ExportPendingIcons(exportCount);
            ReportIconProgress();
        }
        if (now < nextSnapshotRequestCheck) return;
        nextSnapshotRequestCheck = now + 0.25f;
        var telemetryDirectory = Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats");
        var continueRequestPath = Path.Combine(telemetryDirectory, "continue.request");
        if (File.Exists(continueRequestPath) && TryClickContinueGame(telemetryDirectory))
        {
            File.Delete(continueRequestPath);
            Instance?.Log.LogInfo("Invoked MainScene.OnContinueBtnClick as requested by the restart script.");
        }

        var catalogRequestPath = Path.Combine(telemetryDirectory, "catalog.request");
        if (File.Exists(catalogRequestPath))
        {
            File.Delete(catalogRequestPath);
            EmitCatalogs(true);
            ReportIconProgress(true);
        }

        var snapshotRequestPath = Path.Combine(telemetryDirectory, "snapshot.request");
        if (File.Exists(snapshotRequestPath))
        {
            File.Delete(snapshotRequestPath);
            EmitLiveSlotSnapshot();
        }

        var codexRequestPath = Path.Combine(telemetryDirectory, "codex.request");
        if (File.Exists(codexRequestPath) && IsSaveDataReady())
        {
            File.Delete(codexRequestPath);
            EmitCodexSnapshot();
        }

        var inventoryRequestPath = Path.Combine(telemetryDirectory, "inventory.request");
        if (File.Exists(inventoryRequestPath) && IsSaveDataReady())
        {
            File.Delete(inventoryRequestPath);
            EmitInventorySnapshot();
        }

        var autoRequestPath = Path.Combine(telemetryDirectory, "auto.request");
        if (File.Exists(autoRequestPath) && IsSaveDataReady())
        {
            var complete = TryEnableAllBattleSlotsFromUi(out var status);
            if (!string.Equals(status, lastAutoUiStatus, StringComparison.Ordinal))
            {
                lastAutoUiStatus = status;
                Instance?.Log.LogInfo($"Auto UI status: {status}");
            }
            if (complete)
            {
                File.Delete(autoRequestPath);
                File.WriteAllText(Path.Combine(telemetryDirectory, "auto.complete"), DateTimeOffset.Now.ToString("O"));
                Instance?.Log.LogInfo("All three visible battle-slot Auto toggles are on and all three battles are running.");
            }
        }
    });

    private static bool TryEnableAllBattleSlotsFromUi(out string status)
    {
        // Each battle slot has a separate Auto Toggle for its prepare, fight, and
        // end UI states. Select the one control that is currently visible and
        // interactable in each slot. Do not write SaveAdvFieldData or call
        // AdvFieldData.SetAuto here.
        var advModType = GameType("AdvMod");
        if (advModType is null)
        {
            status = "AdvMod type unavailable";
            return false;
        }
        var advMods = FindActiveSceneObjects(advModType).ToList();
        if (advMods.Count != 1)
        {
            status = $"active AdvMod count={advMods.Count}, expected=1";
            return false;
        }

        var fieldCells = ReadList(Read(advMods[0], "advFieldList")).ToList();
        if (fieldCells.Count != 3)
        {
            status = $"field-cell count={fieldCells.Count}, expected=3";
            return false;
        }
        var selectedMods = new List<object>();
        var toggles = new List<object>();
        var selectedNames = new List<string>();
        var autoModProperties = new[] { "advPrepareMod", "advFightMod", "advEndMod" };
        for (var slotIndex = 0; slotIndex < fieldCells.Count; slotIndex++)
        {
            var candidates = autoModProperties.Select(property =>
                (Name: property, Mod: Read(fieldCells[slotIndex], property)))
                .Where(candidate => candidate.Mod is not null)
                .Select(candidate => (candidate.Name, Mod: candidate.Mod!, Toggle: Read(candidate.Mod, "autoToggle")))
                .Where(candidate => candidate.Toggle is not null
                    && Convert.ToBoolean(Read(Read(candidate.Toggle, "gameObject"), "activeInHierarchy") ?? false, CultureInfo.InvariantCulture)
                    && Convert.ToBoolean(Read(candidate.Toggle, "interactable") ?? false, CultureInfo.InvariantCulture))
                .ToList();
            if (candidates.Count != 1)
            {
                stableAutoUiSignature = null;
                stableAutoUiSince = 0f;
                status = $"slot {slotIndex + 1} active/interactable Auto-control count={candidates.Count}, expected=1";
                return false;
            }
            selectedNames.Add(candidates[0].Name);
            selectedMods.Add(candidates[0].Mod);
            toggles.Add(candidates[0].Toggle!);
        }

        var dataMgr = ReadStatic("Game", "dataMgr");
        var advData = Read(Read(dataMgr, "nowSeasonData"), "advData");
        var dataFields = ReadList(Read(advData, "advFieldList")).Take(3).ToList();
        if (dataFields.Count != 3)
        {
            status = $"live battle-field count={dataFields.Count}, expected=3";
            return false;
        }
        var uiFieldPointers = selectedMods.Select(mod => NativePointer(Read(mod, "advFieldData")!)).OrderBy(value => value).ToList();
        var dataFieldPointers = dataFields.Select(NativePointer).OrderBy(value => value).ToList();
        if (!uiFieldPointers.SequenceEqual(dataFieldPointers))
        {
            status = "the three visible Auto controls do not map to the three live battle fields";
            return false;
        }

        var signature = string.Join("|", toggles.Select(toggle => NativePointer(toggle!)));
        if (!string.Equals(signature, stableAutoUiSignature, StringComparison.Ordinal))
        {
            stableAutoUiSignature = signature;
            stableAutoUiSince = Time.realtimeSinceStartup;
            status = $"visible Auto controls=[{string.Join(",", selectedNames)}]; waiting for UI listeners to settle";
            return false;
        }
        if (Time.realtimeSinceStartup - stableAutoUiSince < 1f)
        {
            status = $"visible Auto controls=[{string.Join(",", selectedNames)}]; waiting for UI listeners to settle";
            return false;
        }

        foreach (var toggle in toggles)
        {
            if (!Convert.ToBoolean(Read(toggle, "isOn") ?? false, CultureInfo.InvariantCulture))
            {
                if (!TryClickUnityToggle(toggle!, out var error))
                {
                    status = $"could not click an Auto control: {error}";
                    return false;
                }
            }
        }

        // A checked box alone is not success. The restart script is acknowledged
        // only when every visible toggle is on and each corresponding field owns
        // a live AdvBattleData instance.
        var toggleStates = toggles.Select(toggle => Convert.ToBoolean(
            Read(toggle, "isOn") ?? false, CultureInfo.InvariantCulture)).ToList();
        var battleStates = dataFields.Select(field => Read(field, "advBattleData") is not null).ToList();
        status = $"toggles=[{string.Join(",", toggleStates)}], battles=[{string.Join(",", battleStates)}]";
        return toggleStates.All(value => value) && battleStates.All(value => value);
    }

    private static bool TryClickUnityToggle(object toggle, out string error)
    {
        try
        {
            var eventSystemType = AppDomain.CurrentDomain.GetAssemblies()
                .Select(assembly => assembly.GetType("UnityEngine.EventSystems.EventSystem", false, false))
                .FirstOrDefault(type => type is not null);
            var pointerEventType = AppDomain.CurrentDomain.GetAssemblies()
                .Select(assembly => assembly.GetType("UnityEngine.EventSystems.PointerEventData", false, false))
                .FirstOrDefault(type => type is not null);
            if (eventSystemType is null || pointerEventType is null)
            {
                error = "Unity EventSystem types unavailable";
                return false;
            }
            var eventSystem = eventSystemType.GetProperty("current", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
            if (eventSystem is null)
            {
                error = "no active Unity EventSystem";
                return false;
            }
            var pointerEvent = Activator.CreateInstance(pointerEventType, new[] { eventSystem });
            if (pointerEvent is null)
            {
                error = "could not create PointerEventData";
                return false;
            }
            var click = toggle.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(method => method.Name == "OnPointerClick" && method.GetParameters().Length == 1);
            if (click is null)
            {
                error = "Toggle.OnPointerClick unavailable";
                return false;
            }
            click.Invoke(toggle, new[] { pointerEvent });
            error = string.Empty;
            return true;
        }
        catch (Exception exception)
        {
            error = exception.GetBaseException().Message;
            return false;
        }
    }

    private static IEnumerable<object> FindActiveSceneObjects(Type componentType)
    {
        var findObjects = typeof(Resources).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .FirstOrDefault(method => method.Name == "FindObjectsOfTypeAll"
                && method.IsGenericMethodDefinition
                && method.GetParameters().Length == 0);
        if (findObjects is null) yield break;
        var objects = findObjects.MakeGenericMethod(componentType).Invoke(null, null);
        foreach (var component in ReadSequence(objects))
        {
            var gameObject = Read(component, "gameObject");
            if (Convert.ToBoolean(Read(gameObject, "activeInHierarchy") ?? false, CultureInfo.InvariantCulture))
            {
                yield return component;
            }
        }
    }

    private static bool TryClickContinueGame(string telemetryDirectory)
    {
        try
        {
            var mainSceneType = GameType("MainScene");
            if (mainSceneType is null) return false;
            foreach (var mainScene in FindActiveSceneObjects(mainSceneType))
            {
                var continueMethod = mainSceneType.GetMethod("OnContinueBtnClick", BindingFlags.Public | BindingFlags.Instance);
                if (continueMethod is null) return false;
                var readyPath = Path.Combine(telemetryDirectory, "continue.ready");
                var positionedPath = Path.Combine(telemetryDirectory, "continue.positioned");
                if (!File.Exists(positionedPath))
                {
                    if (!File.Exists(readyPath)) File.WriteAllText(readyPath, DateTimeOffset.Now.ToString("O"));
                    return false;
                }
                continueMethod.Invoke(mainScene, null);
                File.Delete(positionedPath);
                if (File.Exists(readyPath)) File.Delete(readyPath);
                return true;
            }
        }
        catch (Exception error)
        {
            Instance?.Log.LogDebug($"Continue-game request is waiting: {error.Message}");
        }
        return false;
    }

    private static bool IsSaveDataReady()
    {
        var dataMgr = ReadStatic("Game", "dataMgr");
        var seasonData = Read(dataMgr, "nowSeasonData");
        var townData = Read(seasonData, "townData");
        var saveTownData = Read(townData, "saveTownData");
        return Read(saveTownData, "codexDic") is not null;
    }

    private static void EmitLiveSlotSnapshot()
    {
        var dataMgr = ReadStatic("Game", "dataMgr");
        var advData = Read(Read(dataMgr, "nowSeasonData"), "advData");
        var slots = ReadList(Read(advData, "advFieldList")).Select((field, fallbackIndex) =>
        {
            var saveField = Read(field, "saveAdvFieldData");
            var index = ReadNullableInt(saveField, "index") ?? fallbackIndex;
            var tallyData = Read(field, "advTallyData");
            var observedBattleTime = GetObservedBattleTime(index);
            var combats = ReadList(Read(Read(field, "advBattleData"), "comPlayerList")).ToList();
            var heroes = ReadList(Read(field, "heroFieldList"))
                .Select(heroField => Read(heroField, "heroData"))
                .Where(hero => hero is not null)
                .Select(hero => DescribeHero(hero!, combats.FirstOrDefault(combat =>
                    NativePointer(Read(combat, "heroData") ?? combat) == NativePointer(hero!)), tallyData, observedBattleTime, GetBattleCapture(index)))
                .ToList();
            return new { battleIndex = index, heroes };
        }).ToList();
        var allHeroes = slots.SelectMany(slot => slot.heroes).ToList();
        ReportIconProgress(true);
        Instance?.writer?.Enqueue("snapshot.slots", new { slots });
        Instance?.writer?.Enqueue("snapshot.heroes", new { heroes = allHeroes });
        Instance?.writer?.Enqueue("snapshot.resources", new { resources = DescribePrimaryResources(), sanctum = DescribeSanctum() });
    }

    private static void EmitCodexSnapshot()
    {
        var rarityDefinitions = new[]
        {
            (Key: "rare", Label: "Rare", Quality: 3),
            (Key: "legendary", Label: "Legendary", Quality: 4),
            (Key: "set", Label: "Set", Quality: 6),
            (Key: "unique", Label: "Unique", Quality: 8),
            (Key: "mythic", Label: "Mythic", Quality: 5)
        };
        var itemEntries = new List<Dictionary<string, object?>>();
        var affixPoolEntries = new List<Dictionary<string, object?>>();
        var poolIdsBySignature = new Dictionary<string, int>(StringComparer.Ordinal);
        var equipRows = ReadValues(ReadStatic("TableData", "TEquipDict")).ToList();
        var liveCodexByEquipId = ReadLiveCodexByEquipId();
        var savedCodexItems = ReadSavedCodexItems();
        var savedCodexByEquipId = savedCodexItems
            .Select(save => (Id: ReadNullableInt(save, "id"), Save: save))
            .Where(entry => entry.Id is not null)
            .GroupBy(entry => entry.Id!.Value)
            .ToDictionary(group => group.Key, group => group.Last().Save);

        foreach (var rarity in rarityDefinitions)
        {
            foreach (var row in equipRows.Where(row => EquipMatchesCodexQuality(row, rarity.Quality)))
            {
                var equipId = ReadNullableInt(row, "id");
                if (equipId is null) continue;
                var icon = ReadString(row, "icon");
                QueueIcon(icon);
                var codexData = liveCodexByEquipId.GetValueOrDefault(equipId.Value)
                    ?? CreateCodexEquipData(equipId.Value, rarity.Quality);
                var stats = DescribeCodexAffixes(codexData);
                var savedCodex = savedCodexByEquipId.GetValueOrDefault(equipId.Value);
                var awarenessSave = codexData is null ? null : InvokeInstance(codexData, "GetAwarenessSaveItem");
                var itemSave = Read(Read(codexData, "itemData"), "saveItemData") ?? savedCodex;
                var wrapperAwarenessLevel = ReadNullableInt(awarenessSave, "awarenessLevel")
                    ?? (codexData is null ? null : InvokeInt(codexData, "GetAwarenessLevel"));
                var wrapperAwareness = ReadNullableInt(awarenessSave, "awareness")
                    ?? (codexData is null ? null : InvokeInt(codexData, "GetAwareness"));
                var awarenessLevel = rarity.Quality == 3
                    ? ReadNullableInt(savedCodex, "awarenessLevel") ?? wrapperAwarenessLevel ?? 0
                    : wrapperAwarenessLevel ?? ReadNullableInt(savedCodex, "awarenessLevel") ?? 0;
                var awareness = rarity.Quality == 3
                    ? ReadNullableInt(savedCodex, "awareness") ?? wrapperAwareness ?? 0
                    : wrapperAwareness ?? ReadNullableInt(savedCodex, "awareness") ?? 0;
                var eligibleAffixIds = stats.Select(stat => stat.Id).ToHashSet();
                var excludedAffixIds = ReadSavedSealAffixIds(itemSave)
                    .Concat(ReadSavedSealAffixIds(savedCodex))
                    .Where(eligibleAffixIds.Contains)
                    .Distinct()
                    .OrderBy(id => id)
                    .ToList();
                var serializableStats = stats.Select(stat => stat.Payload).ToList();
                var poolSignature = string.Join("|", serializableStats.Select(stat =>
                    $"{stat.GetValueOrDefault("id")}:{stat.GetValueOrDefault("rank9Range")}:{stat.GetValueOrDefault("englishDescription")}"));
                if (!poolIdsBySignature.TryGetValue(poolSignature, out var poolId))
                {
                    poolId = affixPoolEntries.Count + 1;
                    poolIdsBySignature[poolSignature] = poolId;
                    affixPoolEntries.Add(new Dictionary<string, object?> { ["id"] = poolId, ["stats"] = serializableStats });
                }

                var rawName = ReadString(row, "name");
                var partId = ReadNullableInt(row, "part") ?? 0;
                var subtypeId = ReadNullableInt(row, "minType") ?? 0;
                var part = InvokeStatic("TableData", "getTEquipPartData", partId);
                var subtype = subtypeId > 0 ? InvokeStatic("TableData", "getTWeaponTypeData", subtypeId) : null;
                var partRawName = ReadString(part, "name");
                var subtypeRawName = ReadString(subtype, "name");
                itemEntries.Add(new Dictionary<string, object?>
                {
                    ["key"] = $"{rarity.Key}:{equipId.Value}",
                    ["id"] = equipId,
                    ["rarity"] = rarity.Key,
                    ["rarityLabel"] = rarity.Label,
                    ["quality"] = rarity.Quality,
                    ["name"] = rawName,
                    ["englishName"] = EnglishName(row, rawName),
                    ["iconKey"] = icon,
                    ["iconUrl"] = IconUrl(icon),
                    ["part"] = partId,
                    ["partName"] = EnglishName(part, partRawName),
                    ["subtype"] = subtypeId,
                    ["subtypeName"] = partId == 1
                        ? ReadString(subtype, "name_en") ?? EnglishName(subtype, subtypeRawName)
                        : null,
                    ["sortIndex"] = ReadNullableInt(row, "index") ?? 0,
                    ["awarenessLevel"] = awarenessLevel,
                    ["awareness"] = awareness,
                    ["affixPoolId"] = poolId,
                    ["excludedAffixIds"] = excludedAffixIds
                });
            }
        }

        itemEntries = itemEntries
            .OrderBy(item => Convert.ToInt32(item["quality"], CultureInfo.InvariantCulture))
            .ThenBy(item => Convert.ToInt32(item["part"], CultureInfo.InvariantCulture))
            .ThenBy(item => Convert.ToInt32(item["subtype"], CultureInfo.InvariantCulture))
            .ThenBy(item => Convert.ToInt32(item["sortIndex"], CultureInfo.InvariantCulture))
            .ThenBy(item => Convert.ToInt32(item["id"], CultureInfo.InvariantCulture))
            .ToList();
        ReportIconProgress(true);
        Instance?.writer?.Enqueue("snapshot.codex", new
        {
            items = itemEntries,
            affixPools = affixPoolEntries,
            rarities = rarityDefinitions.Select(rarity => new
            {
                key = rarity.Key,
                label = rarity.Label,
                quality = rarity.Quality,
                count = itemEntries.Count(item => string.Equals(Convert.ToString(item["rarity"]), rarity.Key, StringComparison.Ordinal))
            }).ToList()
        });
    }

    private static void EmitInventorySnapshot()
    {
        var dataMgr = ReadStatic("Game", "dataMgr");
        var seasonData = Read(dataMgr, "nowSeasonData");
        var lordData = Read(seasonData, "lordData");
        var bagData = Read(lordData, "lordBagData");
        var itemType = GameType("EItemType");
        var equipType = itemType is null ? null : Enum.ToObject(itemType, 2);
        // GetFieldList(equip) reads the live inventory collection regardless of which
        // bag page the player currently has open. It does not switch UI state or
        // mutate/save anything.
        var inventoryFields = equipType is null ? null : InvokeInstance(bagData!, "GetFieldList", equipType);
        var fieldEntries = ReadList(inventoryFields).ToList();
        var items = new List<Dictionary<string, object?>>();
        foreach (var (field, fallbackIndex) in fieldEntries.Select((field, index) => (field, index)))
        {
            var item = Read(field, "itemData");
            if (item is null) continue;
            var described = DescribeItem(item);
            described["storageLocation"] = "inventory";
            described["inventoryIndex"] = ReadNullableInt(Read(field, "saveItemFieldData"), "index") ?? fallbackIndex;
            items.Add(described);
        }

        var houseStoreData = ReadValues(Read(Read(seasonData, "townData"), "houseDic"))
            .Select(house => Read(house, "houseStoreData"))
            .FirstOrDefault(store => Read(store, "storeBaseData") is not null || Read(store, "storeTreaData") is not null);
        var storeBaseData = Read(houseStoreData, "storeBaseData");
        var warehousePages = ReadEntries(Read(storeBaseData, "storeDic"))
            .Select((entry, ordinal) => new
            {
                Page = Read(entry, "Value"),
                Key = ReadNullableInt(entry, "Key"),
                Ordinal = ordinal
            })
            .Where(entry => entry.Page is not null)
            .ToList();
        var warehouseUsesZeroBasedKeys = warehousePages.Any(entry => entry.Key == 0);
        foreach (var pageEntry in warehousePages)
        {
            var storageTab = pageEntry.Key is { } key
                ? key + (warehouseUsesZeroBasedKeys ? 1 : 0)
                : pageEntry.Ordinal + 1;
            foreach (var (field, fallbackIndex) in ReadList(pageEntry.Page).Select((field, index) => (field, index)))
            {
                var item = Read(field, "itemData");
                if (!IsEquipmentItem(item)) continue;
                var described = DescribeItem(item!);
                described["storageLocation"] = "warehouse";
                described["storagePage"] = storageTab;
                described["storagePageKey"] = pageEntry.Key;
                described["inventoryIndex"] = ReadNullableInt(Read(field, "saveItemFieldData"), "index") ?? fallbackIndex;
                items.Add(described);
            }
        }

        var storeTreaData = Read(houseStoreData, "storeTreaData");
        foreach (var groupList in ReadValues(Read(storeTreaData, "equipGroupDic")))
        {
            foreach (var group in ReadList(groupList))
            {
                var saveGroup = Read(group, "saveEquipGroupData");
                var groupId = ReadNullableInt(saveGroup, "id") ?? ReadNullableInt(Read(group, "tEquipData"), "id");
                foreach (var (item, itemIndex) in ReadList(Read(group, "equipList")).Select((item, index) => (item, index)))
                {
                    if (!IsEquipmentItem(item)) continue;
                    var described = DescribeItem(item);
                    described["storageLocation"] = "vault";
                    described["storageGroupId"] = groupId;
                    described["inventoryIndex"] = itemIndex;
                    items.Add(described);
                }
            }
        }
        ReportIconProgress(true);
        Instance?.writer?.Enqueue("snapshot.inventory", new { source = "all-storage", items });
    }

    private static void InventoryItemAddedPostfix(object __0, bool __result) => SafeHook("inventory-item-added", () =>
    {
        if (!__result) return;
        var save = Read(__0, "saveItemData");
        if (!string.Equals(Read(save, "type")?.ToString(), "equip", StringComparison.OrdinalIgnoreCase)) return;
        var item = DescribeItem(__0);
        item["storageLocation"] = "inventory";
        item["inventoryIndex"] = ReadNullableInt(__0, "fieldIndex");
        ReportIconProgress(true);
        Instance?.writer?.Enqueue("inventory.item-added", new { item });
    });

    private static bool IsEquipmentItem(object? item)
        => item is not null && string.Equals(Read(Read(item, "saveItemData"), "type")?.ToString(), "equip", StringComparison.OrdinalIgnoreCase);

    private static List<object> ReadSavedCodexItems()
    {
        var dataMgr = ReadStatic("Game", "dataMgr");
        var seasonData = Read(dataMgr, "nowSeasonData");
        var townData = Read(seasonData, "townData");
        var saveTownData = Read(townData, "saveTownData");
        return ReadValues(Read(saveTownData, "codexDic")).ToList();
    }

    private static IEnumerable<int> ReadSavedSealAffixIds(object? saveItemData)
    {
        if (saveItemData is null) yield break;
        var list = InvokeInstance(saveItemData, "GetSealAffixList") ?? Read(saveItemData, "sealAffixList");
        foreach (var value in ReadList(list))
        {
            int id;
            try { id = Convert.ToInt32(value, CultureInfo.InvariantCulture); }
            catch { continue; }
            if (id > 0) yield return id;
        }
    }

    private static Dictionary<int, object> ReadLiveCodexByEquipId()
    {
        var dataMgr = ReadStatic("Game", "dataMgr");
        var seasonData = Read(dataMgr, "nowSeasonData");
        var townData = Read(seasonData, "townData");
        var townCodexData = Read(townData, "townCodexData");
        var result = new Dictionary<int, object>();
        foreach (var codexData in ReadValues(Read(townCodexData, "equipCodexDic")))
        {
            var equipId = ReadNullableInt(Read(codexData, "tEquipData"), "id")
                ?? ReadNullableInt(codexData, "id");
            if (equipId is not null) result[equipId.Value] = codexData;
        }
        return result;
    }

    private static bool EquipMatchesCodexQuality(object equipRow, int quality)
    {
        try
        {
            var qualityType = GameType("EItemQualityType");
            var method = GameType("TownCodexData")?.GetMethod("EquipMatchesUnlockCodexQuality", BindingFlags.Public | BindingFlags.Static);
            if (qualityType is null || method is null) return false;
            return Convert.ToBoolean(method.Invoke(null, new[] { Enum.ToObject(qualityType, quality), equipRow }), CultureInfo.InvariantCulture);
        }
        catch { return false; }
    }

    private static object? CreateCodexEquipData(int equipId, int quality)
    {
        try
        {
            var save = InvokeStaticArgs("SaveItemData", "CreateCodexStub", equipId, quality, 110);
            var positionType = GameType("EItemPosType");
            if (save is null || positionType is null) return null;
            var item = InvokeStaticArgs("ItemData", "Create", save, Enum.ToObject(positionType, 12), 0);
            return item is null ? null : InvokeStaticArgs("CodexEquipData", "Create", equipId, item);
        }
        catch { return null; }
    }

    private static List<CodexAffixDescription> DescribeCodexAffixes(object? codexData)
    {
        if (codexData is null) return new();
        InvokeInstance(codexData, "GetSealAffixDic");
        return ReadValues(Read(codexData, "sealAffixDic"))
            .Select(seal =>
            {
                var affix = Read(seal, "tAffixData");
                var affixQuality = Read(seal, "tAffixQualityData");
                var id = ReadNullableInt(seal, "affixId") ?? ReadNullableInt(affix, "id") ?? 0;
                var rawDescription = ReadString(affix, "des");
                return new CodexAffixDescription
                {
                    Id = id,
                    IsExcluded = Convert.ToBoolean(Read(seal, "isSeal") ?? false, CultureInfo.InvariantCulture),
                    Payload = new Dictionary<string, object?>
                    {
                        ["id"] = id,
                        ["rank"] = 9,
                        ["description"] = rawDescription,
                        ["englishDescription"] = EnglishText(affix, "_des", rawDescription),
                        ["displayDescription"] = ReadString(seal, "affixDes"),
                        ["rank9Range"] = InvokeInstanceString(seal, "GetAttrRange", 9),
                        ["quality"] = ReadNullableInt(affixQuality, "id"),
                        ["qualityName"] = EnglishName(affixQuality, ReadString(affixQuality, "name"))
                    }
                };
            })
            .Where(stat => stat.Id > 0)
            .OrderBy(stat => stat.Id)
            .ToList();
    }

    public override bool Unload()
    {
        harmony?.UnpatchSelf();
        writer?.Dispose();
        Instance = null;
        return true;
    }

    private void Patch(string typeName, string methodName, string postfixName)
    {
        var type = GameType(typeName) ?? throw new InvalidOperationException($"Game type not found: {typeName}");
        var original = AccessTools.Method(type, methodName) ?? throw new InvalidOperationException($"Game method not found: {typeName}.{methodName}");
        var postfix = AccessTools.Method(typeof(Plugin), postfixName) ?? throw new InvalidOperationException($"Plugin hook not found: {postfixName}");
        harmony!.Patch(original, postfix: new HarmonyMethod(postfix));
        Log.LogInfo($"Hooked {typeName}.{methodName}");
    }

    private void PatchWithContext(string typeName, string methodName, string prefixName, string finalizerName)
    {
        var type = GameType(typeName) ?? throw new InvalidOperationException($"Game type not found: {typeName}");
        var original = AccessTools.Method(type, methodName) ?? throw new InvalidOperationException($"Game method not found: {typeName}.{methodName}");
        harmony!.Patch(original,
            prefix: new HarmonyMethod(AccessTools.Method(typeof(Plugin), prefixName)),
            finalizer: new HarmonyMethod(AccessTools.Method(typeof(Plugin), finalizerName)));
        Log.LogInfo($"Hooked {typeName}.{methodName} effect context");
    }

    private void PatchOverload(string typeName, string methodName, int parameterCount, string postfixName)
    {
        var type = GameType(typeName) ?? throw new InvalidOperationException($"Game type not found: {typeName}");
        var original = type.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .SingleOrDefault(method => method.Name == methodName && method.GetParameters().Length == parameterCount)
            ?? throw new InvalidOperationException($"Game overload not found: {typeName}.{methodName}/{parameterCount}");
        var postfix = AccessTools.Method(typeof(Plugin), postfixName) ?? throw new InvalidOperationException($"Plugin hook not found: {postfixName}");
        harmony!.Patch(original, postfix: new HarmonyMethod(postfix));
        Log.LogInfo($"Hooked {typeName}.{methodName}/{parameterCount}");
    }

    private static void AbilityResultPrefix(object __instance, out object? __state)
    {
        __state = currentEffectSkill;
        currentEffectSkill = Read(Read(__instance, "triggerData"), "skillData");
    }

    private static Exception? AbilityResultFinalizer(Exception? __exception, object? __state)
    {
        currentEffectSkill = __state;
        return __exception;
    }

    private static void AbilityAddedPostfix(object? __result)
    {
        if (__result is null) return;
        var pointer = NativePointer(__result);
        if (pointer == 0) return;

        // AddAbility may return an object at an address previously used by an expired
        // ability. Invalidate that address on every add, even when no source skill
        // context is available; missing provenance is safer than stale provenance.
        lock (StateLock) EffectOrigins.Remove(pointer);
        if (currentEffectSkill is null) return;

        var origin = DescribeSkillOrigin(currentEffectSkill, ReadNullableInt(Read(currentEffectSkill, "tSkillData"), "id"), Read(currentEffectSkill, "ownCombatData"));
        origin["originKind"] = "skill";
        lock (StateLock) EffectOrigins[pointer] = EffectOriginRecord.Capture(__result, origin);
    }

    private static void AbilityRemovedPrefix(object __instance)
    {
        var pointer = NativePointer(__instance);
        if (pointer == 0) return;
        lock (StateLock) EffectOrigins.Remove(pointer);
    }

    private static void BattleCreatedPostfix(object? __result) => SafeHook("battle-created", () =>
    {
        if (__result is null) return;
        var index = ReadInt(__result, "fieldIndex");
        lock (StateLock) Battles[index] = new BattleCapture(index, DateTimeOffset.UtcNow);
        Instance?.writer?.Enqueue("battle.started", new
        {
            battleIndex = index,
            adventureType = Read(__result, "advType")?.ToString(),
            wave = ReadNullableInt(Read(__result, "battleMapData"), "enemyWave")
        });
    });

    private static void EnemyCreatedPostfix(object[] __args, object? __result) => SafeHook("enemy-created", () =>
    {
        if (__result is null || __args.Length == 0) return;
        var index = Convert.ToInt32(__args[0], CultureInfo.InvariantCulture);
        lock (StateLock)
        {
            if (!Battles.TryGetValue(index, out var capture)) Battles[index] = capture = new BattleCapture(index, DateTimeOffset.UtcNow);
            capture.Enemies.Add(DescribeEnemy(__result));
        }
    });

    private static void ActionCastPostfix(object __instance) => SafeHook("action-cast", () =>
    {
        var combat = Read(__instance, "ownCombatData");
        var hero = Read(combat, "heroData");
        var skill = Read(__instance, "ownSkillData");
        var heroUniqueId = ReadNullableInt(Read(hero, "saveHeroData"), "uniqueId");
        var talentId = ResolveTalentOriginId(hero, skill);
        var battleIndex = ReadNullableInt(__instance, "fieldIndex") ?? ReadNullableInt(combat, "fieldIndex");
        if (heroUniqueId is null || talentId is null || battleIndex is null) return;
        lock (StateLock)
        {
            if (Battles.TryGetValue(battleIndex.Value, out var capture))
                capture.IncrementCast(heroUniqueId.Value, "talent", talentId.Value);
        }
    });

    private static int? ResolveTalentOriginId(object? hero, object? skill)
    {
        var directId = ReadNullableInt(Read(Read(skill, "ownTalentData"), "tTalentData"), "id");
        if (directId is not null) return directId;
        var skillId = ReadNullableInt(Read(skill, "tSkillData"), "id");
        if (hero is null || skillId is null) return null;
        foreach (var talent in ReadValues(Read(Read(hero, "heroTalentData"), "talentDic")))
        {
            var definition = Read(talent, "tTalentData");
            if (ReadNullableInt(definition, "skillId") == skillId)
                return ReadNullableInt(definition, "id");
        }
        return null;
    }

    private static void TallyDamageAddedPostfix(object __instance, object[] __args) => SafeHook("tally-damage-added", () =>
    {
        if (__args.Length < 5 || !string.Equals(__args[1]?.ToString(), "damage", StringComparison.OrdinalIgnoreCase)) return;
        var value = Convert.ToDouble(__args[4], CultureInfo.InvariantCulture);
        if (value <= 0) return;
        var heroUniqueId = ReadNullableInt(Read(__args[0], "saveHeroData"), "uniqueId");
        var originType = __args[2]?.ToString();
        var originId = Convert.ToInt32(__args[3], CultureInfo.InvariantCulture);
        var battleIndex = ReadNullableInt(Read(Read(__instance, "advFieldData"), "saveAdvFieldData"), "index");
        if (heroUniqueId is null || string.IsNullOrWhiteSpace(originType) || battleIndex is null) return;
        lock (StateLock)
        {
            if (Battles.TryGetValue(battleIndex.Value, out var capture))
                capture.IncrementHit(heroUniqueId.Value, originType, originId);
        }
    });

    private static void BulletCritPostfix(object[] __args) =>
        CaptureBulletResolution(__args, isCritical: true);

    private static void BulletDodgePostfix(object[] __args) =>
        CaptureBulletResolution(__args, isCritical: false);

    private static void CaptureBulletResolution(object[] args, bool isCritical) =>
        SafeHook(isCritical ? "bullet-critical" : "bullet-dodge", () =>
        {
            if (args.Length == 0 || args[0] is null) return;
            var bullet = args[0];
            var emitter = Read(bullet, "ownEmitterData");
            var combat = Read(emitter, "ownCombatData");
            var hero = Read(combat, "heroData");
            var skill = Read(emitter, "ownSkillData") ?? Read(Read(emitter, "ownActionData"), "ownSkillData");
            var heroUniqueId = ReadNullableInt(Read(hero, "saveHeroData"), "uniqueId");
            var talentId = ResolveTalentOriginId(hero, skill);
            var battleIndex = ReadNullableInt(bullet, "fieldIndex")
                ?? ReadNullableInt(emitter, "fieldIndex")
                ?? ReadNullableInt(combat, "fieldIndex");
            if (heroUniqueId is null || talentId is null || battleIndex is null) return;
            lock (StateLock)
            {
                if (!Battles.TryGetValue(battleIndex.Value, out var capture)) return;
                if (isCritical) capture.IncrementCritical(heroUniqueId.Value, "talent", talentId.Value);
                else capture.IncrementMiss(heroUniqueId.Value, "talent", talentId.Value);
            }
        });

    private static void BattleEndedPostfix(object __instance, object[] __args) => SafeHook("battle-ended", () =>
    {
        var index = ReadNullableInt(Read(__instance, "saveAdvFieldData"), "index") ?? -1;
        if (index < 0) return;
        BattleCapture capture;
        lock (StateLock)
        {
            if (!Battles.TryGetValue(index, out capture!)) capture = new BattleCapture(index, DateTimeOffset.UtcNow);
            Battles[index] = new BattleCapture(index, DateTimeOffset.UtcNow);
        }
        var battle = Read(__instance, "advBattleData");
        var battleMap = Read(battle, "battleMapData");
        var mapSite = Read(battleMap, "mapSiteData");
        var chapSite = Read(mapSite, "chapSiteData");
        var siteRow = Read(chapSite, "tChapterSiteData");
        var chapterRow = Read(chapSite, "tChapterData") ?? Read(mapSite, "tChapterData")
            ?? Read(Read(battleMap, "mapChapterData"), "tChapterData");
        var placeTitle = ReadString(mapSite, "titleStr") ?? ReadString(siteRow, "name");
        var englishChapter = EnglishName(chapterRow, ReadString(chapterRow, "name"));
        var chapterSiteId = ReadNullableInt(siteRow, "id");
        var siteIndex = ReadNullableInt(siteRow, "index");
        var chapterSiteType = ReadNullableInt(siteRow, "type");
        var adventureType = Read(battle, "advType")?.ToString();
        var englishPlaceTitle = !string.IsNullOrWhiteSpace(englishChapter) && siteIndex is not null
            ? $"{englishChapter}-{siteIndex}" : EnglishName(siteRow, placeTitle);
        var heroes = ReadList(Read(battle, "comPlayerList"))
            .Select(combat => Read(combat, "heroData"))
            .Where(hero => hero is not null)
            .Select(hero =>
            {
                var combat = ReadList(Read(battle, "comPlayerList"))
                    .FirstOrDefault(candidate => NativePointer(Read(candidate, "heroData") ?? candidate) == NativePointer(hero!));
                return DescribeHero(hero!, combat, Read(Read(battle, "advFieldData"), "advTallyData"),
                    Math.Max(0, (DateTimeOffset.UtcNow - capture.StartedAt).TotalSeconds), capture);
            }).ToList();
        EmitCatalogs();
        ReportIconProgress(true);
        var endedAt = DateTimeOffset.UtcNow;
        Instance?.writer?.Enqueue("battle.ended", new
        {
            battleIndex = index,
            result = __args.FirstOrDefault()?.ToString() ?? Read(battle, "battleEndType")?.ToString(),
            capture.StartedAt,
            endedAt,
            durationSeconds = Math.Round((endedAt - capture.StartedAt).TotalSeconds, 3),
            adventureType,
            placeTitle,
            englishPlaceTitle,
            chapterSiteId,
            chapterSiteType,
            isTreasure = chapterSiteType == 2,
            wave = ReadNullableInt(battleMap, "enemyWave"),
            enemyCount = capture.Enemies.Count,
            enemies = capture.Enemies,
            loot = DescribeBattleLoot(__instance, battle, adventureType),
            resources = DescribePrimaryResources(),
            sanctum = DescribeSanctum(),
            heroes
        });
        Instance?.writer?.Enqueue("snapshot.heroes", new { heroes });
    });

    private static List<Dictionary<string, object?>> DescribeBattleLoot(object field, object? battle, string? adventureType)
    {
        var items = ReadList(Read(field, "dropItemList")).ToList();
        if (string.Equals(adventureType, "tower", StringComparison.OrdinalIgnoreCase))
        {
            // Tower boss drops are deliberately held outside AdvFieldData.dropItemList until
            // after BattleEnd. They include the remaining Gold/Blood and occasional chests.
            // Other adventure modes have already folded boss drops into the field list here.
            var pointers = new HashSet<nint>(items.Select(NativePointer).Where(pointer => pointer != 0));
            foreach (var pending in ReadList(Read(battle, "pendingBossDropList")))
            {
                var pointer = NativePointer(pending);
                if (pointer != 0 && !pointers.Add(pointer)) continue;
                items.Add(pending);
            }
        }
        return AggregateLoot(items.Select(DescribeItem));
    }

    private static Dictionary<string, object?> DescribeEnemy(object combat)
    {
        var table = Read(combat, "tEnemyData");
        return new()
        {
            ["id"] = ReadNullableInt(table, "id"), ["name"] = ReadString(table, "name"),
            ["englishName"] = EnglishName(table, ReadString(table, "name")),
            ["level"] = ReadNullableInt(combat, "level"), ["attributeLevel"] = ReadNullableInt(combat, "attrLevel"),
            ["enemyType"] = Read(combat, "enemyType")?.ToString()
        };
    }

    private static Dictionary<string, object?> DescribeHero(object hero, object? combat = null, object? tallyData = null, double? observedBattleTime = null, BattleCapture? battleCapture = null)
    {
        var save = Read(hero, "saveHeroData");
        var jobId = ReadNullableInt(save, "jobId");
        var baseSkillId = ReadNullableInt(save, "baseSkillId");
        var classIcon = jobId is null ? null : $"job_{jobId}";
        QueueIcon(classIcon);
        var equipped = ReadList(Read(Read(hero, "heroEquipData"), "fieldList"))
            .Select(field => Read(field, "itemData")).Where(item => item is not null)
            .Select(item => DescribeItem(item!)).ToList();
        var currentHealth = ReadNullableDouble(Read(combat, "comResData"), "nowHp");
        return new()
        {
            ["uniqueId"] = ReadNullableInt(save, "uniqueId"), ["id"] = ReadNullableInt(save, "id"),
            ["name"] = ReadString(save, "name"), ["job"] = ReadString(hero, "jobName"),
            ["englishJob"] = EnglishName(Read(hero, "tHeroJobData"), ReadString(hero, "jobName")),
            ["jobId"] = jobId, ["classIconUrl"] = IconUrl(classIcon),
            ["baseSkillId"] = baseSkillId,
            ["level"] = ReadNullableInt(save, "level"),
            ["experience"] = ReadNullableInt(save, "exp"), ["quality"] = ReadNullableInt(save, "quality"),
            ["blessLevel"] = ReadNullableInt(save, "blessLevel"), ["sanity"] = ReadNullableInt(save, "sanityPoint"),
            ["attributes"] = DescribeAttributes(Read(hero, "attrData")),
            ["stats"] = DescribeStats(Read(hero, "attrData"), hero, ReadNullableInt(save, "level")),
            ["combatStats"] = DescribeStats(Read(combat, "attrData"), hero, ReadNullableInt(save, "level")),
            ["combatEffects"] = TryDescribeCombatEffects(combat),
            ["damageDone"] = TryDescribeDamageDone(hero, tallyData, observedBattleTime, battleCapture),
            ["inCombat"] = combat is not null,
            ["currentHealth"] = currentHealth,
            ["isDead"] = combat is not null && currentHealth is <= 0,
            ["equippedItems"] = equipped
            , ["talents"] = ReadValues(Read(Read(hero, "heroTalentData"), "talentDic")).Select(DescribeHeroTalent).ToList()
        };
    }

    private static Dictionary<string, object?>? TryDescribeDamageDone(object hero, object? tallyData, double? observedBattleTime, BattleCapture? battleCapture)
    {
        if (tallyData is null) return null;
        try { return DescribeDamageDone(hero, tallyData, observedBattleTime, battleCapture); }
        catch (Exception error)
        {
            Instance?.Log.LogWarning($"Damage-meter extraction failed safely: {error.Message}");
            return null;
        }
    }

    private static Dictionary<string, object?> DescribeDamageDone(object hero, object tallyData, double? observedBattleTime, BattleCapture? battleCapture)
    {
        var heroUniqueId = ReadNullableInt(Read(hero, "saveHeroData"), "uniqueId");
        var fieldData = Read(tallyData, "advFieldData");
        var savedBattleTime = ReadNullableDouble(Read(fieldData, "saveAdvFieldData"), "battleTime") ?? 0;
        var meterBattleTime = ReadNullableDouble(tallyData, "battleTime") ?? 0;
        var battleTime = Math.Max(0, savedBattleTime > 0 ? savedBattleTime : meterBattleTime > 0 ? meterBattleTime : observedBattleTime ?? 0);
        object? damageItems = null;
        foreach (var entry in ReadEntries(Read(tallyData, "tallyItemDic")))
        {
            if (!string.Equals(Read(entry, "Key")?.ToString(), "damage", StringComparison.OrdinalIgnoreCase)) continue;
            damageItems = Read(entry, "Value");
            break;
        }

        var entries = new List<Dictionary<string, object?>>();
        foreach (var item in ReadList(damageItems))
        {
            var save = Read(item, "saveTallyItemData");
            if (heroUniqueId is null || ReadNullableInt(save, "heroUniqueId") != heroUniqueId) continue;
            var damage = Math.Max(0, ReadNullableDouble(save, "tallyValue") ?? 0);
            if (damage <= 0) continue;

            var originType = Read(save, "originType")?.ToString();
            var originId = ReadNullableInt(save, "id");
            var source = Read(item, "tSkillData") ?? Read(item, "tTalentData") ?? Read(item, "tMasteryData")
                ?? Read(item, "tEquipData") ?? Read(item, "tSummonData");
            var name = ReadString(item, "nameStr") ?? ReadString(source, "name")
                ?? (originId is not null ? $"{originType ?? "source"} {originId}" : "Unknown source");
            var englishName = EnglishName(source, name);
            var icon = ReadString(item, "iconStr") ?? ReadString(source, "icon");
            QueueIcon(icon);

            // TallyItemData.RefreshPerSecond uses this same battle time. Calculate from the
            // meter's accumulated value so snapshots remain correct even when its UI is closed.
            var dps = battleTime > 0 ? damage / battleTime : 0;
            entries.Add(new()
            {
                ["key"] = $"{originType ?? "unknown"}:{originId?.ToString(CultureInfo.InvariantCulture) ?? "unknown"}",
                ["originType"] = originType,
                ["originId"] = originId,
                ["name"] = name,
                ["englishName"] = englishName,
                ["iconKey"] = icon,
                ["iconUrl"] = IconUrl(icon),
                ["damage"] = damage,
                ["dps"] = dps,
                ["castCount"] = battleCapture is not null && heroUniqueId is not null && originId is not null
                    ? battleCapture.GetCastCount(heroUniqueId.Value, originType, originId.Value)
                    : null,
                ["hitCount"] = battleCapture is not null && heroUniqueId is not null && originId is not null
                    ? battleCapture.GetHitCount(heroUniqueId.Value, originType, originId.Value)
                    : null,
                ["criticalCount"] = battleCapture is not null && heroUniqueId is not null && originId is not null
                    ? battleCapture.GetCriticalCount(heroUniqueId.Value, originType, originId.Value)
                    : null,
                ["missCount"] = battleCapture is not null && heroUniqueId is not null && originId is not null
                    ? battleCapture.GetMissCount(heroUniqueId.Value, originType, originId.Value)
                    : null,
                ["share"] = ReadNullableDouble(item, "per")
            });
        }

        entries = entries.OrderByDescending(entry => Convert.ToDouble(entry["dps"] ?? 0, CultureInfo.InvariantCulture))
            .ThenBy(entry => Convert.ToString(entry["englishName"] ?? entry["name"], CultureInfo.InvariantCulture))
            .ToList();
        var totalDamage = entries.Sum(entry => Convert.ToDouble(entry["damage"] ?? 0, CultureInfo.InvariantCulture));
        return new()
        {
            ["battleTimeSeconds"] = battleTime,
            ["battleTimeSource"] = savedBattleTime > 0 ? "saveAdvFieldData.battleTime"
                : meterBattleTime > 0 ? "advTallyData.battleTime" : "battle.created elapsed time",
            ["totalDamage"] = totalDamage,
            ["totalDps"] = battleTime > 0 ? totalDamage / battleTime : 0,
            ["entries"] = entries
        };
    }

    private static double? GetObservedBattleTime(int battleIndex)
    {
        lock (StateLock)
        {
            return Battles.TryGetValue(battleIndex, out var capture)
                ? Math.Max(0, (DateTimeOffset.UtcNow - capture.StartedAt).TotalSeconds)
                : null;
        }
    }

    private static BattleCapture? GetBattleCapture(int battleIndex)
    {
        lock (StateLock) return Battles.TryGetValue(battleIndex, out var capture) ? capture : null;
    }

    private static List<Dictionary<string, object?>> TryDescribeCombatEffects(object? combat)
    {
        try { return DescribeCombatEffects(combat); }
        catch (Exception error)
        {
            Instance?.Log.LogWarning($"Combat effect extraction failed safely: {error.Message}");
            return new();
        }
    }

    private static List<Dictionary<string, object?>> DescribeCombatEffects(object? combat)
    {
        if (combat is null) return new();
        var displayedEffects = DescribeDisplayedCombatEffects(combat);
        if (displayedEffects.Count > 0) return displayedEffects;

        var abilities = ReadList(Read(Read(combat, "comAbilityData"), "abilityList"))
            .Where(ability => ability is not null)
            .Select(ability => new { Ability = ability!, Definition = Read(ability, "tAbilityData") })
            .Where(entry => entry.Definition is not null && ReadNullableInt(entry.Definition, "type") is >= 1 and <= 7)
            .GroupBy(entry => new
            {
                DefinitionPointer = NativePointer(entry.Definition!),
                DefinitionId = ReadNullableInt(entry.Definition, "id") ?? 0,
                Source = Read(entry.Ability, "fromCombatData") is { } source ? NativePointer(source) : (nint)0,
                Level = ReadNullableInt(entry.Ability, "level")
            });
        var result = new List<Dictionary<string, object?>>();
        foreach (var group in abilities)
        {
            var first = group.First();
            result.Add(DescribeCombatEffect(combat, first.Ability, group.Count(), null, "runtime-list"));
        }
        return result.OrderBy(effect => Convert.ToString(effect["classification"], CultureInfo.InvariantCulture))
            .ThenBy(effect => Convert.ToString(effect["englishName"], CultureInfo.InvariantCulture)).ToList();
    }

    private static List<Dictionary<string, object?>> DescribeDisplayedCombatEffects(object combat)
    {
        var barType = GameType("BarCombatCell");
        if (barType is null) return new();
        object? bars;
        try
        {
            var finder = typeof(Resources).GetMethod("FindObjectsOfTypeAll", new[] { typeof(Type) });
            bars = finder?.Invoke(null, new object[] { barType });
        }
        catch { return new(); }

        foreach (var bar in ReadSequence(bars))
        {
            if (NativePointer(Read(bar, "combatData")!) != NativePointer(combat)) continue;
            var result = new List<Dictionary<string, object?>>();
            foreach (var cell in ReadList(Read(bar, "abilityCellList")))
            {
                var ability = Read(cell, "abilityData");
                if (ability is null) continue;
                var table = Read(ability, "tAbilityData");
                if (table is null || ReadNullableInt(table, "type") is not (>= 1 and <= 7)) continue;
                var sprite = Read(Read(cell, "iconImg"), "sprite") as Sprite;
                var spriteName = sprite is null ? null : ReadString(sprite, "name");
                var iconKey = sprite is null ? null : $"displayed_effect_{ReadNullableInt(table, "id")}_{spriteName ?? "sprite"}";
                if (sprite is not null && iconKey is not null) ExportSprite(sprite, iconKey);
                result.Add(DescribeCombatEffect(combat, ability, Math.Max(1, ReadNullableInt(cell, "floor") ?? 1), iconKey, "game-ui"));
            }
            return result.OrderBy(effect => Convert.ToString(effect["classification"], CultureInfo.InvariantCulture))
                .ThenBy(effect => Convert.ToString(effect["englishName"], CultureInfo.InvariantCulture)).ToList();
        }
        return new();
    }

    private static Dictionary<string, object?> DescribeCombatEffect(object targetCombat, object ability, int stacks, string? displayedIconKey, string representation)
    {
        var table = Read(ability, "tAbilityData");
        var definitionId = ReadNullableInt(table, "id") ?? 0;
        var source = Read(ability, "fromCombatData");
        var sourceHero = Read(source, "heroData");
        var sourceHeroSave = Read(sourceHero, "saveHeroData");
        var sourceEnemy = Read(source, "tEnemyData");
        var sourceName = ReadString(sourceHeroSave, "name") ?? EnglishName(sourceEnemy, ReadString(sourceEnemy, "name"));
        var origin = FindExactAbilityOrigin(targetCombat, ability) ?? FindExactItemOrigin(sourceHero, table);
        var tableName = ReadString(table, "name");
        var tableEnglishName = ReadString(table, "name_en") ?? EnglishName(table, tableName);
        var tableDescription = ReadString(table, "des");
        var tableEnglishDescription = ReadString(table, "des_en") ?? EnglishText(table, "_des", tableDescription);
        var typeId = ReadNullableInt(table, "type");
        var tableIcon = ReadString(table, "icon");
        var originIcon = Convert.ToString(origin?["iconKey"], CultureInfo.InvariantCulture);
        var useVerifiedOriginPresentation = typeId is 1 or 6 && origin is not null;
        var tableHasDistinctIcon = !string.IsNullOrWhiteSpace(tableIcon)
            && !tableIcon.StartsWith("ability_", StringComparison.OrdinalIgnoreCase);
        var icon = displayedIconKey
            ?? (tableHasDistinctIcon ? tableIcon : useVerifiedOriginPresentation && !string.IsNullOrWhiteSpace(originIcon) ? originIcon : tableIcon);
        QueueIcon(icon);
        return new Dictionary<string, object?>
        {
            ["id"] = definitionId,
            ["definitionId"] = definitionId,
            ["runtimeId"] = ReadNullableInt(ability, "id"),
            ["name"] = tableName,
            ["englishName"] = tableEnglishName,
            ["description"] = tableDescription,
            ["englishDescription"] = tableEnglishDescription,
            ["iconKey"] = icon,
            ["iconUrl"] = IconUrl(icon),
            ["typeId"] = typeId,
            ["type"] = AbilityTypeName(typeId),
            ["classification"] = AbilityClassification(typeId),
            ["stacks"] = stacks,
            ["configuredStack"] = ReadNullableInt(table, "stack"),
            ["level"] = ReadNullableInt(ability, "level"),
            ["duration"] = ReadNullableDouble(ability, "duration"),
            ["elapsedDuration"] = ReadNullableDouble(ability, "nowDuration"),
            ["sourceName"] = sourceName,
            ["sourceHeroId"] = ReadNullableInt(sourceHeroSave, "uniqueId"),
            ["sourceKind"] = sourceHero is not null ? "hero" : sourceEnemy is not null ? "enemy" : "unknown",
            ["sourceSkillId"] = origin?["skillId"],
            ["sourceSkillName"] = origin?["englishName"] ?? origin?["name"],
            ["sourceIconKey"] = originIcon,
            ["sourceIconUrl"] = IconUrl(originIcon),
            ["originKind"] = origin?["originKind"],
            ["originName"] = origin?["englishName"] ?? origin?["name"],
            ["originVerified"] = origin is not null,
            ["representation"] = representation
        };
    }

    private static Dictionary<string, object?>? FindExactAbilityOrigin(object targetCombat, object ability)
    {
        foreach (var aura in ReadList(Read(targetCombat, "auraEffectList")))
        {
            if (!ReadList(Read(aura, "abilityList")).Any(item => NativePointer(item) == NativePointer(ability))) continue;
            var auraSkill = Read(aura, "ownSkillData");
            var auraSkillId = InvokeInt(aura, "GetAuraSourceSkillId") ?? ReadNullableInt(Read(auraSkill, "tSkillData"), "id");
            var sourceCombat = Read(aura, "fromCombatData");
            auraSkill ??= ReadList(Read(Read(sourceCombat, "comSkillData"), "skillList"))
                .FirstOrDefault(skill => ReadNullableInt(Read(skill, "tSkillData"), "id") == auraSkillId);
            if (auraSkill is not null)
            {
                var origin = DescribeSkillOrigin(auraSkill, auraSkillId, sourceCombat);
                origin["originKind"] = "skill";
                return origin;
            }
        }
        var abilityPointer = NativePointer(ability);
        lock (StateLock)
        {
            if (!EffectOrigins.TryGetValue(abilityPointer, out var capturedOrigin)) return null;
            if (capturedOrigin.Matches(ability)) return new Dictionary<string, object?>(capturedOrigin.Origin);

            // IL2CPP can reuse a destroyed object's native address. Never let provenance
            // captured for the previous object leak into the new effect at that address.
            EffectOrigins.Remove(abilityPointer);
        }
        return null;
    }

    private static Dictionary<string, object?> DescribeSkillOrigin(object skill, int? knownSkillId, object? knownSourceCombat = null)
    {
        var skillTable = Read(skill, "tSkillData");
        var info = Read(skill, "tSkillInfoData");
        var talentTable = Read(Read(skill, "ownTalentData"), "tTalentData");
        var skillId = ReadNullableInt(skillTable, "id") ?? knownSkillId;
        var skillName = ReadString(skillTable, "name");
        var skillEnglishName = EnglishName(skillTable, skillName);
        var talentSkillId = ReadNullableInt(talentTable, "skillId");
        var talentName = ReadString(talentTable, "name");
        var talentEnglishName = EnglishName(talentTable, talentName);
        var talentMatchesSkill = talentTable is not null
            && (talentSkillId == skillId || (!string.IsNullOrWhiteSpace(skillEnglishName)
                && string.Equals(talentEnglishName, skillEnglishName, StringComparison.Ordinal)));
        if (!talentMatchesSkill) talentTable = null;
        if (talentTable is null && skillId is > 0)
        {
            var hero = Read(knownSourceCombat ?? Read(skill, "ownCombatData"), "heroData");
            talentTable = ReadValues(Read(Read(hero, "heroTalentData"), "talentDic"))
                .Select(talent => Read(talent, "tTalentData"))
                .FirstOrDefault(table => ReadNullableInt(table, "skillId") == skillId);
        }
        var description = ReadString(info, "des");
        var icon = ReadString(talentTable, "icon");
        QueueIcon(icon);
        return new Dictionary<string, object?>
        {
            ["skillId"] = skillId,
            ["name"] = skillName,
            ["englishName"] = skillEnglishName,
            ["description"] = description,
            ["englishDescription"] = ReadString(info, "des_en") ?? EnglishText(info, "_des", description),
            ["iconKey"] = icon
        };
    }

    private static Dictionary<string, object?>? FindExactItemOrigin(object? sourceHero, object? abilityTable)
    {
        if (sourceHero is null || abilityTable is null) return null;
        var matches = new Dictionary<nint, object>();
        foreach (var field in ReadList(Read(Read(sourceHero, "heroEquipData"), "fieldList")))
        {
            var item = Read(field, "itemData");
            if (item is null) continue;
            var equip = Read(item, "itemEquipData");
            var affixes = new List<object>();
            affixes.AddRange(ReadList(Read(equip, "affixList")));
            var runewordAffix = Read(equip, "runewordsAffixData");
            if (Read(runewordAffix, "tAbilityData") is not null) affixes.Add(runewordAffix!);
            affixes.AddRange(ReadList(runewordAffix));
            foreach (var rune in ReadList(Read(equip, "slotRuneList")))
                affixes.AddRange(ReadList(Read(rune, "affixList")));
            foreach (var affix in affixes)
            {
                if (NativePointer(Read(affix, "tAbilityData")!) != NativePointer(abilityTable)) continue;
                matches[NativePointer(item)] = item;
            }
        }
        if (matches.Count != 1) return null;
        var described = DescribeItem(matches.Values.Single());
        return new Dictionary<string, object?>
        {
            ["originKind"] = "item",
            ["itemId"] = described.GetValueOrDefault("id"),
            ["name"] = described.GetValueOrDefault("name"),
            ["englishName"] = described.GetValueOrDefault("englishName"),
            ["iconKey"] = described.GetValueOrDefault("iconKey")
        };
    }

    private static string AbilityClassification(int? typeId) => typeId switch
    {
        1 or 4 or 6 or 7 => "buff",
        2 or 3 => "debuff",
        _ => "other"
    };

    private static string AbilityTypeName(int? typeId) => typeId switch
    {
        1 => "Buff", 2 => "Weaken", 3 => "Ailment", 4 => "Enhancement",
        5 => "Continuous", 6 => "Aura", 7 => "Immunity", _ => "Other"
    };

    private static Dictionary<string, object?> DescribeHeroTalent(object talent)
    {
        var save = Read(talent, "saveTalentData");
        var table = Read(talent, "tTalentData");
        var skill = Read(talent, "skillData");
        var skillTable = Read(skill, "tSkillData");
        var info = Read(skill, "tSkillInfoData");
        var talentId = ReadNullableInt(save, "id") ?? ReadNullableInt(table, "id");
        var skillId = ReadNullableInt(table, "skillId") ?? ReadNullableInt(skillTable, "id");
        var masteryId = ReadNullableInt(table, "masteryId");
        var masteryTable = masteryId is > 0 && skillId is not > 0
            ? InvokeStatic("TableData", "getTMasteryData", masteryId.Value)
            : null;
        var titleSource = masteryTable ?? table;
        var rawTitle = ReadString(titleSource, "name") ?? ReadString(table, "name");
        var baseSkillId = ReadNullableInt(Read(Read(talent, "ownHeroData"), "saveHeroData"), "baseSkillId");
        var positionId = ReadNullableInt(save, "posId") ?? 0;
        var positionRow = positionId == 0 ? null : InvokeStatic("TableData", "getTTalentPosData", positionId);
        var icon = ReadString(table, "icon");
        QueueIcon(icon);
        return new()
        {
            ["id"] = talentId,
            ["name"] = rawTitle, ["englishName"] = EnglishName(titleSource, rawTitle),
            ["description"] = ReadString(info, "des"), ["englishDescription"] = EnglishText(info, "_des", ReadString(info, "des")),
            ["rank"] = ReadNullableInt(save, "level"), ["effectiveRank"] = InvokeInt(talent, "GetLevel"),
            ["maxRank"] = InvokeInt(talent, "GetTalentLevelCap"), ["baseRank"] = ReadNullableInt(talent, "baseLevel"),
            ["position"] = positionId,
            ["positionRow"] = ReadNullableInt(positionRow, "row"), ["positionColumn"] = ReadNullableInt(positionRow, "col"),
            ["positionType"] = ReadNullableInt(positionRow, "type"), ["positionIndex"] = ReadNullableInt(positionRow, "index"),
            ["fixed"] = Read(save, "isFixed"),
            ["inspired"] = Read(save, "isInspired"), ["alien"] = Read(save, "isAlien"),
            ["skillId"] = skillId, ["selected"] = baseSkillId is not null && (skillId == baseSkillId || talentId == baseSkillId),
            ["iconKey"] = icon, ["iconUrl"] = IconUrl(icon)
        };
    }

    private static Dictionary<string, object?> DescribeItem(object item)
    {
        var save = Read(item, "saveItemData") ?? item;
        var equip = Read(item, "itemEquipData");
        var definition = Read(equip, "tEquipData")
            ?? Read(Read(item, "itemRuneData"), "tRuneData")
            ?? Read(Read(item, "itemResData"), "tResData")
            ?? Read(Read(item, "itemToolData"), "tToolData")
            ?? Read(Read(item, "itemCurioData"), "tCurioData")
            ?? Read(item, "tItemData");
        var runtimeName = InvokeString(item, "GetName");
        var specificName = ReadString(definition, "name") ?? runtimeName;
        var icon = ReadString(item, "iconStr") ?? ReadString(definition, "icon")
            ?? ReadString(Read(item, "itemRuneData"), "icon") ?? ReadString(Read(item, "itemResData"), "icon");
        QueueIcon(icon);
        var partId = ReadNullableInt(definition, "part");
        var subtypeId = ReadNullableInt(definition, "minType");
        var part = partId is > 0 ? InvokeStatic("TableData", "getTEquipPartData", partId.Value) : null;
        var subtype = subtypeId is > 0 ? InvokeStatic("TableData", "getTWeaponTypeData", subtypeId.Value) : null;
        var quality = ReadNullableInt(save, "quality");
        var affixes = ReadList(Read(equip, "affixList")).Select(DescribeInventoryAffix).ToList();
        if (affixes.Count == 0) affixes = ReadList(Read(save, "affixList")).Select(DescribeInventoryAffix).ToList();
        return new()
        {
            ["id"] = ReadNullableInt(save, "id"),
            ["name"] = specificName,
            ["englishName"] = EnglishName(definition, specificName),
            ["type"] = Read(save, "type")?.ToString(), ["count"] = ReadNullableInt(save, "count"),
            ["quality"] = quality, ["qualityName"] = EnglishName(Read(item, "tItemQualityData"), ReadString(Read(item, "tItemQualityData"), "name")),
            ["rarity"] = quality switch { 3 => "rare", 4 => "legendary", 5 => "mythic", 6 => "set", 8 => "unique", _ => "other" },
            ["level"] = ReadNullableInt(save, "level"), ["forgeLevel"] = ReadNullableInt(save, "forgeLevel"),
            ["slotCount"] = ReadNullableInt(save, "slotCount"), ["mainAttributeValue"] = ReadNullableInt(save, "mainAttrValue"),
            ["position"] = Read(item, "posType")?.ToString(),
            ["part"] = partId, ["partName"] = EnglishName(part, ReadString(part, "name")),
            ["subtype"] = subtypeId, ["subtypeName"] = partId == 1 ? ReadString(subtype, "name_en") ?? EnglishName(subtype, ReadString(subtype, "name")) : null,
            ["iconKey"] = icon, ["iconUrl"] = IconUrl(icon),
            ["affixes"] = affixes,
            ["runes"] = ReadList(Read(save, "slotRuneList")).Select(DescribeSimpleObject).ToList()
        };
    }

    private static Dictionary<string, object?> DescribeInventoryAffix(object affix)
    {
        var save = Read(affix, "saveData") ?? affix;
        var id = ReadNullableInt(save, "id") ?? ReadNullableInt(affix, "id");
        var definition = Read(affix, "tAffixData") ?? (id is > 0 ? InvokeStatic("TableData", "getTAffixData", id.Value) : null);
        var quality = Read(affix, "tAffixQualityData");
        var rawDescription = ReadString(definition, "des");
        return new()
        {
            ["id"] = id,
            ["rank"] = ReadNullableInt(save, "level"),
            ["quality"] = ReadNullableInt(save, "quality"),
            ["qualityName"] = EnglishName(quality, ReadString(quality, "name")),
            ["value"] = ReadNullableInt(save, "value"),
            ["description"] = rawDescription,
            ["englishDescription"] = EnglishText(definition, "_des", rawDescription),
            ["displayDescription"] = InvokeString(affix, "GetDesc")
        };
    }

    private static List<Dictionary<string, object?>> AggregateLoot(IEnumerable<Dictionary<string, object?>> items)
    {
        var result = new List<Dictionary<string, object?>>();
        var stackIndexes = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            var type = item.GetValueOrDefault("type")?.ToString() ?? "unknown";
            var id = item.GetValueOrDefault("id")?.ToString() ?? "unknown";
            var stackable = !type.Equals("equip", StringComparison.OrdinalIgnoreCase);
            var key = type + ":" + id;
            if (stackable && stackIndexes.TryGetValue(key, out var existingIndex))
            {
                var existing = result[existingIndex];
                var total = Convert.ToInt32(existing.GetValueOrDefault("count") ?? 0, CultureInfo.InvariantCulture)
                    + Convert.ToInt32(item.GetValueOrDefault("count") ?? 0, CultureInfo.InvariantCulture);
                existing["count"] = total;
                continue;
            }
            var copy = new Dictionary<string, object?>(item);
            if (stackable) stackIndexes[key] = result.Count;
            result.Add(copy);
        }
        return result;
    }

    private static List<Dictionary<string, object?>> DescribePrimaryResources()
    {
        var result = new List<Dictionary<string, object?>>();
        var dataManager = GameType("Game")?.GetProperty("dataMgr", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
        var town = Read(Read(dataManager, "nowSeasonData"), "townData");
        foreach (var resource in ReadValues(Read(town, "resDic")))
        {
            var save = Read(resource, "saveResData");
            var definition = Read(resource, "tResData");
            var id = ReadNullableInt(save, "id") ?? ReadNullableInt(definition, "id");
            if (id is not (1 or 2 or 3)) continue;
            var name = ReadString(definition, "name");
            var icon = ReadString(definition, "icon");
            QueueIcon(icon);
            result.Add(new Dictionary<string, object?>
            {
                ["id"] = id,
                ["count"] = ReadNullableInt(save, "count") ?? 0,
                ["name"] = name,
                ["englishName"] = EnglishName(definition, name),
                ["iconKey"] = icon,
                ["iconUrl"] = IconUrl(icon)
            });
        }
        return result.OrderBy(resource => Convert.ToInt32(resource["id"], CultureInfo.InvariantCulture)).ToList();
    }

    private static Dictionary<string, object?> DescribeSanctum()
    {
        var dataManager = ReadStatic("Game", "dataMgr");
        var season = Read(dataManager, "nowSeasonData");
        var advData = Read(season, "advData");
        var saveMap = Read(Read(advData, "mapData"), "saveMapData");
        var floor = ReadNullableInt(saveMap, "towerFloor");
        return new Dictionary<string, object?>
        {
            ["floor"] = floor,
            // The Sanctum grants +2% primary-resource gain per completed floor.
            // The API represents percentages as rates, hence 121 => 2.42 => +242%.
            ["resourceBonusRate"] = floor is null ? null : floor.Value * 0.02d
        };
    }

    private static Dictionary<string, object?> DescribeAttributes(object? attrData)
    {
        var output = new Dictionary<string, object?>();
        if (attrData is null) return output;
        var enumType = GameType("EAttrType");
        var getter = attrData.GetType().GetMethod("GetAttrValue", BindingFlags.Instance | BindingFlags.Public);
        if (enumType is null || getter is null) return output;
        foreach (var value in Enum.GetValues(enumType)) try
        {
            var number = Convert.ToSingle(getter.Invoke(attrData, new[] { value }), CultureInfo.InvariantCulture);
            if (Math.Abs(number) > 0.00001f) output[value.ToString() ?? "unknown"] = number;
        }
        catch { }
        return output;
    }

    private static List<Dictionary<string, object?>> DescribeStats(object? attrData, object hero, int? level)
    {
        var output = new List<Dictionary<string, object?>>();
        if (attrData is null) return output;
        var enumType = GameType("EAttrType");
        var getter = attrData.GetType().GetMethod("GetAttrValue", BindingFlags.Instance | BindingFlags.Public);
        if (enumType is null || getter is null) return output;
        foreach (var enumValue in Enum.GetValues(enumType)) try
        {
            var id = Convert.ToInt32(enumValue, CultureInfo.InvariantCulture);
            var value = Convert.ToSingle(getter.Invoke(attrData, new[] { enumValue }), CultureInfo.InvariantCulture);
            if (Math.Abs(value) <= 0.00001f) continue;
            var row = InvokeStatic("TableData", "getTAttrData", id);
            var rawName = ReadString(row, "name") ?? enumValue.ToString() ?? $"Stat {id}";
            var englishName = EnglishName(row, HumanizeIdentifier(enumValue.ToString() ?? $"Stat {id}"));
            var rawDescription = ReadString(row, "des");
            var englishDescription = EnglishText(row, "_des", rawDescription);
            var info = InvokeStaticArgs("AttrInfoData", "Create", id, value, attrData, level ?? 1, true, true, true);
            if (info is not null) info.GetType().GetMethod("SetOwnHeroData")?.Invoke(info, new[] { hero });
            var displayValue = info is null ? null : InvokeString(info, "GetDesc");
            var special = info is null ? null : InvokeString(info, "GetSpecialDesc");
            var explanation = info is null ? null : InvokeString(info, "GetExplain");
            output.Add(new()
            {
                ["id"] = id, ["key"] = enumValue.ToString(), ["name"] = rawName, ["englishName"] = englishName,
                ["value"] = value, ["displayValue"] = displayValue,
                ["description"] = rawDescription, ["englishDescription"] = englishDescription,
                ["specialDescription"] = special, ["explanation"] = explanation,
                ["showType"] = ReadNullableInt(row, "showType"), ["valueType"] = ReadNullableInt(row, "valueType"),
                ["type"] = ReadNullableInt(row, "type"), ["typeParam"] = ReadNullableInt(row, "typeParam")
            });
        }
        catch { }
        return output.OrderBy(stat => Convert.ToInt32(stat["id"], CultureInfo.InvariantCulture)).ToList();
    }

    private static string HumanizeIdentifier(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return value;
        var builder = new StringBuilder(value.Length + 8);
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            if (index > 0 && char.IsUpper(character) && !char.IsUpper(value[index - 1])) builder.Append(' ');
            builder.Append(index == 0 ? char.ToUpperInvariant(character) : character);
        }
        return builder.ToString();
    }

    private static Dictionary<string, object?> DescribeSimpleObject(object value)
    {
        var output = new Dictionary<string, object?>();
        foreach (var property in value.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public)) try
        {
            if (!property.CanRead || property.GetIndexParameters().Length != 0) continue;
            var raw = property.GetValue(value);
            if (raw is null || raw is string || raw.GetType().IsPrimitive || raw.GetType().IsEnum) output[property.Name] = raw?.ToString();
        }
        catch { }
        return output;
    }

    private static void EmitCatalogs(bool force = false)
    {
        lock (StateLock)
        {
            if (catalogSent && !force) return;
            catalogSent = true;
        }
        EmitCatalog("jobs", "THeroJobDict", DescribeJobDefinition);
        EmitCatalog("talents", "TTalentDict", DescribeTalentDefinition);
        EmitCatalog("skills", "TSkillDict", DescribeSkillDefinition);
        EmitCatalog("abilities", "TAbilityDict", row => DescribeDefinition(row, "ability"));
        EmitCatalog("materials", "TResDict", row => DescribeDefinition(row, "material"));
        EmitCatalog("runes", "TRuneDict", row => DescribeDefinition(row, "rune"));
        EmitCatalog("tools", "TToolDict", row => DescribeDefinition(row, "tool"));
        EmitCatalog("curios", "TCurioDict", row => DescribeDefinition(row, "curio"));
        EmitCatalog("equipment", "TEquipDict", row => DescribeDefinition(row, "equipment"));
    }

    private static void EmitCatalog(string name, string property, Func<object, Dictionary<string, object?>> describe)
    {
        var dictionary = ReadStatic("TableData", property);
        var entries = ReadValues(dictionary).Select(describe).ToList();
        Instance?.writer?.Enqueue("catalog." + name, new { entries });
    }

    private static Dictionary<string, object?> DescribeTalentDefinition(object row)
    {
        var skillId = ReadNullableInt(row, "skillId");
        var masteryId = ReadNullableInt(row, "masteryId");
        var mastery = masteryId is > 0 && skillId is not > 0
            ? InvokeStatic("TableData", "getTMasteryData", masteryId.Value)
            : null;
        var titleSource = mastery ?? row;
        var rawTitle = ReadString(titleSource, "name") ?? ReadString(row, "name");
        var skill = skillId is > 0 ? InvokeStatic("TableData", "getTSkillData", skillId.Value) : null;
        var infoId = ReadNullableInt(skill, "infoId");
        var info = infoId is > 0 ? InvokeStatic("TableData", "getTSkillInfoData", infoId.Value) : null;
        var icon = ReadString(row, "icon"); QueueIcon(icon);
        return new()
        {
            ["kind"] = "talent", ["id"] = ReadNullableInt(row, "id"), ["jobId"] = ReadNullableInt(row, "jobId"),
            ["name"] = rawTitle, ["englishName"] = EnglishName(titleSource, rawTitle),
            ["description"] = ReadString(info, "des"), ["englishDescription"] = EnglishText(info, "_des", ReadString(info, "des")),
            ["skillId"] = skillId, ["masteryId"] = masteryId,
            ["floor"] = ReadNullableInt(row, "floor"), ["iconKey"] = icon, ["iconUrl"] = IconUrl(icon),
            ["rankDescriptions"] = masteryId is > 0 && skillId is not > 0 ? DescribeTalentRanks(skillId, masteryId, info) : null
        };
    }

    private static Dictionary<string, object?> DescribeJobDefinition(object row)
    {
        var id = ReadNullableInt(row, "id");
        var icon = id is > 0 ? $"job_{id}" : ReadString(row, "icon");
        QueueIcon(icon);
        return new()
        {
            ["kind"] = "job", ["id"] = id,
            ["name"] = ReadString(row, "name"), ["englishName"] = EnglishName(row, ReadString(row, "name")),
            ["iconKey"] = icon, ["iconUrl"] = IconUrl(icon)
        };
    }

    private static List<string?> DescribeTalentRanks(int? skillId, int? masteryId, object? fallbackInfo)
    {
        var descriptions = new List<string?>(15);
        for (var rank = 1; rank <= 15; rank++)
        {
            try
            {
                var parts = new List<string>();
                var preview = skillId is > 0 ? InvokeStaticArgs("SkillData", "CreatePreview", skillId.Value, rank, null!) : null;
                var info = Read(preview, "tSkillInfoData") ?? fallbackInfo;
                AddDescription(parts, EnglishText(info, "_des", ReadString(info, "des")));
                foreach (var attribute in ReadList(Read(Read(preview, "skillExplainData"), "skillAttrList")))
                {
                    AddDescription(parts, ReadString(attribute, "des"));
                    AddDescription(parts, ReadString(attribute, "explain"));
                }

                var mastery = masteryId is > 0 ? InvokeStaticArgs("MasteryData", "CreateByShow", masteryId.Value, rank, 15) : null;
                mastery?.GetType().GetMethod("UpdateAffixList", BindingFlags.Instance | BindingFlags.Public)?.Invoke(mastery, null);
                mastery?.GetType().GetMethod("InitExplainList", BindingFlags.Instance | BindingFlags.Public)?.Invoke(mastery, null);
                foreach (var affix in ReadList(Read(mastery, "affixList"))) AddDescription(parts, InvokeString(affix, "GetDesc"));
                descriptions.Add(parts.Count == 0 ? null : string.Join("\n", parts));
            }
            catch
            {
                descriptions.Add(EnglishText(fallbackInfo, "_des", ReadString(fallbackInfo, "des")));
            }
        }
        return descriptions;
    }

    private static void AddDescription(List<string> descriptions, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        var normalized = value.Trim();
        if (!descriptions.Contains(normalized, StringComparer.Ordinal)) descriptions.Add(normalized);
    }

    private static Dictionary<string, object?> DescribeSkillDefinition(object row)
    {
        var infoId = ReadNullableInt(row, "infoId");
        var info = infoId is > 0 ? InvokeStatic("TableData", "getTSkillInfoData", infoId.Value) : null;
        return new()
        {
            ["kind"] = "skill", ["id"] = ReadNullableInt(row, "id"), ["jobId"] = ReadNullableInt(row, "job"),
            ["name"] = ReadString(row, "name"), ["englishName"] = EnglishName(row, ReadString(row, "name")),
            ["description"] = ReadString(info, "des"), ["englishDescription"] = EnglishText(info, "_des", ReadString(info, "des")),
            ["infoId"] = infoId, ["type"] = ReadNullableInt(row, "type")
        };
    }

    private static Dictionary<string, object?> DescribeDefinition(object row, string kind)
    {
        var icon = ReadString(row, "icon"); QueueIcon(icon);
        var currentName = ReadString(row, "name");
        var currentDescription = ReadString(row, "des");
        return new()
        {
            ["kind"] = kind, ["id"] = ReadNullableInt(row, "id"),
            ["name"] = currentName, ["englishName"] = ReadString(row, "name_en") ?? EnglishName(row, currentName),
            ["description"] = currentDescription,
            ["englishDescription"] = ReadString(row, "des_en") ?? EnglishText(row, "_des", currentDescription),
            ["quality"] = ReadNullableInt(row, "quality"), ["iconKey"] = icon, ["iconUrl"] = IconUrl(icon)
        };
    }

    private static string? EnglishText(object? row, string rawProperty, string? fallback)
    {
        var key = ReadString(row, rawProperty) ?? ReadString(row, rawProperty + "_k__BackingField");
        if (string.IsNullOrWhiteSpace(key)) return fallback;
        var translation = InvokeStatic("TableData", "getTLanguage_MultiLangData", key);
        return ReadString(translation, "en") is { Length: > 0 } english ? english : fallback;
    }

    private static void QueueIcon(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return;
        lock (StateLock)
        {
            if (!KnownIcons.Add(key)) return;
            var path = Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats", "icons", IconFile(key));
            if (!File.Exists(path)) PendingIcons.Enqueue(key);
        }
    }

    private static string? IconUrl(string? key) => string.IsNullOrWhiteSpace(key) ? null : "/assets/icons/" + IconFile(key);
    private static string IconFile(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant() + ".png";

    private static int lastReportedIconTotal = -1;
    private static int lastReportedIconCompleted = -1;
    private static float nextIconProgressReport;

    private static void ReportIconProgress(bool force = false)
    {
        var now = Time.realtimeSinceStartup;
        if (!force && now < nextIconProgressReport) return;
        nextIconProgressReport = now + 0.2f;
        int total;
        int pending;
        lock (StateLock)
        {
            total = KnownIcons.Count;
            pending = PendingIcons.Count;
        }
        var completed = Math.Max(0, total - pending);
        if (!force && total == lastReportedIconTotal && completed == lastReportedIconCompleted) return;
        lastReportedIconTotal = total;
        lastReportedIconCompleted = completed;
        var progress = new { total, completed, pending, complete = catalogSent && total > 0 && pending == 0 };
        Instance?.writer?.Enqueue("snapshot.icon-progress", progress);
        try
        {
            var directory = Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "icons.progress.json");
            var temporaryPath = path + ".tmp";
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(progress));
            File.Move(temporaryPath, path, true);
        }
        catch (Exception error) { Instance?.Log.LogDebug($"Icon progress persistence skipped: {error.Message}"); }
    }

    private static void ExportPendingIcons(int limit)
    {
        var directory = Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats", "icons");
        Directory.CreateDirectory(directory);
        var retry = new List<string>();
        for (var count = 0; count < limit; count++)
        {
            string? key = null;
            lock (StateLock) { if (PendingIcons.Count > 0) key = PendingIcons.Dequeue(); }
            if (key is null) break;
            var path = Path.Combine(directory, IconFile(key));
            if (File.Exists(path)) continue;
            try
            {
                var resMgr = ReadStatic("Game", "resMgr");
                var sprite = resMgr?.GetType().GetMethod("GetSprite")?.Invoke(resMgr, new object[] { key }) as Sprite;
                if (sprite is null || !ExportSprite(sprite, key)) retry.Add(key);
            }
            catch (Exception error)
            {
                retry.Add(key);
                Instance?.Log.LogDebug($"Icon export deferred for {key}: {error.Message}");
            }
        }
        lock (StateLock) foreach (var key in retry) PendingIcons.Enqueue(key);
    }

    private static bool ExportSprite(Sprite sprite, string key)
    {
        var directory = Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats", "icons");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, IconFile(key));
        if (File.Exists(path)) return true;
        RenderTexture? renderTarget = null;
        Texture2D? copy = null;
        var temporaryPath = path + ".tmp";
        var previousRenderTarget = RenderTexture.active;
        try
        {
            var rect = sprite.textureRect;
            var width = Math.Max(1, Mathf.RoundToInt(rect.width));
            var height = Math.Max(1, Mathf.RoundToInt(rect.height));
            var source = sprite.texture;
            renderTarget = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
            var scale = new Vector2(rect.width / source.width, rect.height / source.height);
            var offset = new Vector2(rect.x / source.width, rect.y / source.height);
            Graphics.Blit(source, renderTarget, scale, offset);
            RenderTexture.active = renderTarget;
            copy = new Texture2D(width, height, TextureFormat.RGBA32, false);
            copy.ReadPixels(new Rect(0, 0, width, height), 0, 0, false);
            copy.Apply(false, false);
            File.WriteAllBytes(temporaryPath, ImageConversion.EncodeToPNG(copy));
            File.Move(temporaryPath, path);
            return true;
        }
        catch (Exception error)
        {
            Instance?.Log.LogDebug($"Runtime sprite export deferred for {key}: {error.Message}");
            return false;
        }
        finally
        {
            RenderTexture.active = previousRenderTarget;
            if (copy is not null) UnityEngine.Object.Destroy(copy);
            if (renderTarget is not null) RenderTexture.ReleaseTemporary(renderTarget);
            try { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); } catch { }
        }
    }

    private static IEnumerable<object> ReadValues(object? collection)
    {
        if (collection is null) yield break;
        var values = Read(collection, "Values") ?? collection;
        var getEnumerator = values.GetType().GetMethod("GetEnumerator", Type.EmptyTypes);
        if (getEnumerator is null) yield break;
        var enumerator = getEnumerator.Invoke(values, null);
        if (enumerator is null) yield break;
        var moveNext = enumerator.GetType().GetMethod("MoveNext", Type.EmptyTypes);
        var current = enumerator.GetType().GetProperty("Current");
        for (var guard = 0; guard < 20000 && moveNext is not null && current is not null && (bool)(moveNext.Invoke(enumerator, null) ?? false); guard++)
        {
            var value = current.GetValue(enumerator); if (value is not null) yield return value;
        }
    }

    private static IEnumerable<object> ReadEntries(object? dictionary)
    {
        if (dictionary is null) yield break;
        var getEnumerator = dictionary.GetType().GetMethod("GetEnumerator", Type.EmptyTypes);
        if (getEnumerator is null) yield break;
        var enumerator = getEnumerator.Invoke(dictionary, null);
        if (enumerator is null) yield break;
        var moveNext = enumerator.GetType().GetMethod("MoveNext", Type.EmptyTypes);
        var current = enumerator.GetType().GetProperty("Current");
        for (var guard = 0; guard < 20000 && moveNext is not null && current is not null && (bool)(moveNext.Invoke(enumerator, null) ?? false); guard++)
        {
            var entry = current.GetValue(enumerator); if (entry is not null) yield return entry;
        }
    }

    private static object? ReadStatic(string typeName, string property)
    {
        try { return GameType(typeName)?.GetProperty(property, BindingFlags.Public | BindingFlags.Static)?.GetValue(null); }
        catch { return null; }
    }

    private static object? InvokeStatic(string typeName, string method, object argument)
    {
        try { return GameType(typeName)?.GetMethod(method, BindingFlags.Public | BindingFlags.Static)?.Invoke(null, new[] { argument }); }
        catch { return null; }
    }

    private static object? InvokeStaticArgs(string typeName, string method, params object[] arguments)
    {
        try
        {
            var candidate = GameType(typeName)?.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(value => value.Name == method && value.GetParameters().Length == arguments.Length);
            return candidate?.Invoke(null, arguments);
        }
        catch { return null; }
    }

    private static object? InvokeInstance(object value, string method, params object[] arguments)
    {
        try
        {
            var candidate = value.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(entry => entry.Name == method && entry.GetParameters().Length == arguments.Length);
            return candidate?.Invoke(value, arguments);
        }
        catch { return null; }
    }

    private static string? InvokeInstanceString(object value, string method, params object[] arguments)
        => InvokeInstance(value, method, arguments)?.ToString();

    private static string? EnglishName(object? tableRow, string? fallback)
    {
        if (tableRow is null) return fallback;
        var key = ReadString(tableRow, "_name")
            ?? ReadString(tableRow, "_name_k__BackingField")
            ?? ReadString(tableRow, "__name_k__BackingField");
        if (string.IsNullOrWhiteSpace(key)) return fallback;
        try
        {
            var tableData = GameType("TableData");
            var resolver = tableData?.GetMethod("getTLanguage_MultiLangData", BindingFlags.Public | BindingFlags.Static);
            var translation = resolver?.Invoke(null, new object[] { key });
            var english = ReadString(translation, "en");
            return string.IsNullOrWhiteSpace(english) ? fallback : english;
        }
        catch { return fallback; }
    }

    private static IEnumerable<object> ReadList(object? list)
    {
        if (list is null) yield break;
        var item = list.GetType().GetMethod("get_Item", new[] { typeof(int) });
        if (item is null) yield break;
        for (var index = 0; index < ReadInt(list, "Count"); index++)
        {
            object? value = null;
            try { value = item.Invoke(list, new object[] { index }); } catch { }
            if (value is not null) yield return value;
        }
    }

    private static IEnumerable<object> ReadSequence(object? sequence)
    {
        if (sequence is null) yield break;
        var item = sequence.GetType().GetMethod("get_Item", new[] { typeof(int) });
        if (item is null) yield break;
        var count = ReadNullableInt(sequence, "Count") ?? ReadNullableInt(sequence, "Length") ?? 0;
        for (var index = 0; index < count; index++)
        {
            object? value = null;
            try { value = item.Invoke(sequence, new object[] { index }); } catch { }
            if (value is not null) yield return value;
        }
    }

    private static object? Read(object? value, string name)
    {
        if (value is null) return null;
        try { return value.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(value); }
        catch { return null; }
    }
    private static int ReadInt(object? value, string name) => Convert.ToInt32(Read(value, name) ?? 0, CultureInfo.InvariantCulture);
    private static int? ReadNullableInt(object? value, string name) => Read(value, name) is { } raw ? Convert.ToInt32(raw, CultureInfo.InvariantCulture) : null;
    private static double? ReadNullableDouble(object? value, string name) => Read(value, name) is { } raw ? Convert.ToDouble(raw, CultureInfo.InvariantCulture) : null;
    private static string? ReadString(object? value, string name) => Read(value, name)?.ToString();
    private static string? InvokeString(object value, string method) { try { return value.GetType().GetMethod(method)?.Invoke(value, null)?.ToString(); } catch { return null; } }
    private static int? InvokeInt(object value, string method) { try { return Convert.ToInt32(value.GetType().GetMethod(method)?.Invoke(value, null), CultureInfo.InvariantCulture); } catch { return null; } }
    private static nint NativePointer(object value) { try { return (nint)(IntPtr)(value.GetType().GetProperty("Pointer")?.GetValue(value) ?? IntPtr.Zero); } catch { return 0; } }
    private static Type? GameType(string name)
    {
        gameAssembly ??= AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(assembly => assembly.GetName().Name == "Assembly-CSharp");
        return gameAssembly?.GetType(name, false, false);
    }
    private static void SafeHook(string name, Action action) { try { action(); } catch (Exception error) { Instance?.Log.LogWarning($"Hook {name} failed safely: {error.Message}"); } }

    private sealed class BattleCapture
    {
        public BattleCapture(int index, DateTimeOffset startedAt) { Index = index; StartedAt = startedAt; }
        public int Index { get; }
        public DateTimeOffset StartedAt { get; }
        public List<Dictionary<string, object?>> Enemies { get; } = new();
        public List<Dictionary<string, object?>> Loot { get; } = new();
        private Dictionary<string, int> CastCounts { get; } = new(StringComparer.OrdinalIgnoreCase);
        private Dictionary<string, int> HitCounts { get; } = new(StringComparer.OrdinalIgnoreCase);
        private Dictionary<string, int> CriticalCounts { get; } = new(StringComparer.OrdinalIgnoreCase);
        private Dictionary<string, int> MissCounts { get; } = new(StringComparer.OrdinalIgnoreCase);
        public void IncrementCast(int heroUniqueId, string originType, int originId)
        {
            var key = $"{heroUniqueId}:{originType}:{originId}";
            CastCounts[key] = CastCounts.GetValueOrDefault(key) + 1;
        }
        public int? GetCastCount(int heroUniqueId, string? originType, int originId)
        {
            if (string.IsNullOrWhiteSpace(originType)) return null;
            return CastCounts.TryGetValue($"{heroUniqueId}:{originType}:{originId}", out var count) ? count : null;
        }
        public void IncrementHit(int heroUniqueId, string originType, int originId)
        {
            var key = $"{heroUniqueId}:{originType}:{originId}";
            HitCounts[key] = HitCounts.GetValueOrDefault(key) + 1;
        }
        public int? GetHitCount(int heroUniqueId, string? originType, int originId)
        {
            if (string.IsNullOrWhiteSpace(originType)) return null;
            return HitCounts.TryGetValue($"{heroUniqueId}:{originType}:{originId}", out var count) ? count : null;
        }
        public void IncrementCritical(int heroUniqueId, string originType, int originId)
        {
            var key = $"{heroUniqueId}:{originType}:{originId}";
            CriticalCounts[key] = CriticalCounts.GetValueOrDefault(key) + 1;
        }
        public int? GetCriticalCount(int heroUniqueId, string? originType, int originId)
        {
            if (string.IsNullOrWhiteSpace(originType)) return null;
            return CriticalCounts.GetValueOrDefault($"{heroUniqueId}:{originType}:{originId}");
        }
        public void IncrementMiss(int heroUniqueId, string originType, int originId)
        {
            var key = $"{heroUniqueId}:{originType}:{originId}";
            MissCounts[key] = MissCounts.GetValueOrDefault(key) + 1;
        }
        public int? GetMissCount(int heroUniqueId, string? originType, int originId)
        {
            if (string.IsNullOrWhiteSpace(originType)) return null;
            return MissCounts.GetValueOrDefault($"{heroUniqueId}:{originType}:{originId}");
        }
    }

    private sealed class CodexAffixDescription
    {
        public int Id { get; init; }
        public bool IsExcluded { get; init; }
        public Dictionary<string, object?> Payload { get; init; } = new();
    }

    private sealed class EffectOriginRecord
    {
        private EffectOriginRecord(object ability, Dictionary<string, object?> origin)
        {
            Origin = new Dictionary<string, object?>(origin);
            DefinitionPointer = NativePointer(Read(ability, "tAbilityData")!);
            DefinitionId = ReadNullableInt(Read(ability, "tAbilityData"), "id");
            RuntimeId = ReadNullableInt(ability, "id");
            SourcePointer = NativePointer(Read(ability, "fromCombatData")!);
            TargetPointer = NativePointer(Read(ability, "ownCombatData")!);
        }

        public Dictionary<string, object?> Origin { get; }
        private nint DefinitionPointer { get; }
        private int? DefinitionId { get; }
        private int? RuntimeId { get; }
        private nint SourcePointer { get; }
        private nint TargetPointer { get; }

        public static EffectOriginRecord Capture(object ability, Dictionary<string, object?> origin) => new(ability, origin);

        public bool Matches(object ability)
        {
            var definition = Read(ability, "tAbilityData");
            return DefinitionPointer == NativePointer(definition!)
                && DefinitionId == ReadNullableInt(definition, "id")
                && RuntimeId == ReadNullableInt(ability, "id")
                && SourcePointer == NativePointer(Read(ability, "fromCombatData")!)
                && TargetPointer == NativePointer(Read(ability, "ownCombatData")!);
        }
    }
}

internal sealed class TelemetryWriter : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly ConcurrentQueue<string> queue = new();
    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(1) };
    private readonly string fallbackPath;
    private readonly BepInEx.Logging.ManualLogSource log;
    private readonly Timer timer;
    private int draining;

    public TelemetryWriter(string directory, BepInEx.Logging.ManualLogSource log)
    {
        Directory.CreateDirectory(directory);
        fallbackPath = Path.Combine(directory, "events.jsonl");
        this.log = log;
        timer = new Timer(_ => _ = DrainAsync(), null, TimeSpan.Zero, TimeSpan.FromMilliseconds(250));
    }
    public void Enqueue(string type, object payload) => queue.Enqueue(JsonSerializer.Serialize(new { type, timestamp = DateTimeOffset.UtcNow, payload }, JsonOptions));
    private async Task DrainAsync()
    {
        if (Interlocked.Exchange(ref draining, 1) != 0) return;
        try
        {
            while (queue.TryDequeue(out var json)) try
            {
                using var content = new StringContent(json, Encoding.UTF8, "application/json");
                using var response = await client.PostAsync("http://127.0.0.1:43127/api/events", content).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) throw new HttpRequestException();
            }
            catch { await File.AppendAllTextAsync(fallbackPath, json + Environment.NewLine, new UTF8Encoding(false)).ConfigureAwait(false); }
        }
        catch (Exception error) { log.LogWarning($"Telemetry writer failed safely: {error.Message}"); }
        finally { Volatile.Write(ref draining, 0); }
    }
    public void Dispose() { timer.Dispose(); client.Dispose(); }
}
