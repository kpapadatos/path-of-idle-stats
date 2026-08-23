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
    public const string PluginVersion = "0.2.0";

    private static Plugin? Instance;
    private static readonly object StateLock = new();
    private static readonly Dictionary<int, BattleCapture> Battles = new();
    private static readonly Queue<string> PendingIcons = new();
    private static readonly HashSet<string> KnownIcons = new(StringComparer.OrdinalIgnoreCase);
    private static bool catalogSent;
    private static float nextSnapshotRequestCheck;
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
        Patch("AdvFieldData", "BattleEnd", nameof(BattleEndedPostfix));
        Patch("TableData", "init", nameof(TableReadyPostfix));
        Patch("Root", "Update", nameof(RootUpdatePostfix));
        writer.Enqueue("heartbeat", new { pluginVersion = PluginVersion, mode = "live" });
        Log.LogInfo($"{PluginName} {PluginVersion} loaded with read-only telemetry hooks.");
    }

    private static void TableReadyPostfix() => SafeHook("table-ready", EmitCatalogOnce);

    private static void RootUpdatePostfix() => SafeHook("snapshot-request", () =>
    {
        if (Time.realtimeSinceStartup < nextSnapshotRequestCheck) return;
        nextSnapshotRequestCheck = Time.realtimeSinceStartup + 0.25f;
        var requestPath = Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats", "snapshot.request");
        if (!File.Exists(requestPath)) return;
        File.Delete(requestPath);
        EmitLiveSlotSnapshot();
    });

    private static void EmitLiveSlotSnapshot()
    {
        var dataMgr = ReadStatic("Game", "dataMgr");
        var advData = Read(Read(dataMgr, "nowSeasonData"), "advData");
        var slots = ReadList(Read(advData, "advFieldList")).Select((field, fallbackIndex) =>
        {
            var saveField = Read(field, "saveAdvFieldData");
            var index = ReadNullableInt(saveField, "index") ?? fallbackIndex;
            var combats = ReadList(Read(Read(field, "advBattleData"), "comPlayerList")).ToList();
            var heroes = ReadList(Read(field, "heroFieldList"))
                .Select(heroField => Read(heroField, "heroData"))
                .Where(hero => hero is not null)
                .Select(hero => DescribeHero(hero!, combats.FirstOrDefault(combat =>
                    NativePointer(Read(combat, "heroData") ?? combat) == NativePointer(hero!))))
                .ToList();
            return new { battleIndex = index, heroes };
        }).ToList();
        var allHeroes = slots.SelectMany(slot => slot.heroes).ToList();
        ExportPendingIcons(32);
        Instance?.writer?.Enqueue("snapshot.slots", new { slots });
        Instance?.writer?.Enqueue("snapshot.heroes", new { heroes = allHeroes });
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
        var siteIndex = ReadNullableInt(siteRow, "index");
        var englishPlaceTitle = !string.IsNullOrWhiteSpace(englishChapter) && siteIndex is not null
            ? $"{englishChapter}-{siteIndex}" : EnglishName(siteRow, placeTitle);
        var heroes = ReadList(Read(battle, "comPlayerList"))
            .Select(combat => Read(combat, "heroData"))
            .Where(hero => hero is not null)
            .Select(hero =>
            {
                var combat = ReadList(Read(battle, "comPlayerList"))
                    .FirstOrDefault(candidate => NativePointer(Read(candidate, "heroData") ?? candidate) == NativePointer(hero!));
                return DescribeHero(hero!, combat);
            }).ToList();
        EmitCatalogOnce();
        ExportPendingIcons(24);
        var endedAt = DateTimeOffset.UtcNow;
        Instance?.writer?.Enqueue("battle.ended", new
        {
            battleIndex = index,
            result = __args.FirstOrDefault()?.ToString() ?? Read(battle, "battleEndType")?.ToString(),
            capture.StartedAt,
            endedAt,
            durationSeconds = Math.Round((endedAt - capture.StartedAt).TotalSeconds, 3),
            adventureType = Read(battle, "advType")?.ToString(),
            placeTitle,
            englishPlaceTitle,
            wave = ReadNullableInt(battleMap, "enemyWave"),
            enemyCount = capture.Enemies.Count,
            enemies = capture.Enemies,
            loot = AggregateLoot(ReadList(Read(__instance, "dropItemList")).Select(DescribeItem)),
            heroes
        });
        Instance?.writer?.Enqueue("snapshot.heroes", new { heroes });
    });

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

    private static Dictionary<string, object?> DescribeHero(object hero, object? combat = null)
    {
        var save = Read(hero, "saveHeroData");
        var jobId = ReadNullableInt(save, "jobId");
        var baseSkillId = ReadNullableInt(save, "baseSkillId");
        var classIcon = jobId is null ? null : $"job_{jobId}";
        QueueIcon(classIcon);
        var equipped = ReadList(Read(Read(hero, "heroEquipData"), "fieldList"))
            .Select(field => Read(field, "itemData")).Where(item => item is not null)
            .Select(item => DescribeItem(item!)).ToList();
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
            ["inCombat"] = combat is not null,
            ["equippedItems"] = equipped
            , ["talents"] = ReadValues(Read(Read(hero, "heroTalentData"), "talentDic")).Select(DescribeHeroTalent).ToList()
        };
    }

    private static Dictionary<string, object?> DescribeHeroTalent(object talent)
    {
        var save = Read(talent, "saveTalentData");
        var table = Read(talent, "tTalentData");
        var skill = Read(talent, "skillData");
        var skillTable = Read(skill, "tSkillData");
        var info = Read(skill, "tSkillInfoData");
        var talentId = ReadNullableInt(save, "id") ?? ReadNullableInt(table, "id");
        var skillId = ReadNullableInt(table, "skillId") ?? ReadNullableInt(skillTable, "id");
        var baseSkillId = ReadNullableInt(Read(Read(talent, "ownHeroData"), "saveHeroData"), "baseSkillId");
        var positionId = ReadNullableInt(save, "posId") ?? 0;
        var positionRow = positionId == 0 ? null : InvokeStatic("TableData", "getTTalentPosData", positionId);
        var icon = ReadString(table, "icon");
        QueueIcon(icon);
        return new()
        {
            ["id"] = talentId,
            ["name"] = ReadString(table, "name"), ["englishName"] = EnglishName(table, ReadString(table, "name")),
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
        var icon = ReadString(item, "iconStr") ?? ReadString(Read(equip, "tEquipData"), "icon")
            ?? ReadString(Read(item, "itemRuneData"), "icon") ?? ReadString(Read(item, "itemResData"), "icon");
        QueueIcon(icon);
        return new()
        {
            ["id"] = ReadNullableInt(save, "id"),
            ["name"] = InvokeString(item, "GetName") ?? ReadString(Read(equip, "tEquipData"), "name"),
            ["englishName"] = EnglishName(Read(equip, "tEquipData") ?? Read(item, "tItemData"), InvokeString(item, "GetName")),
            ["type"] = Read(save, "type")?.ToString(), ["count"] = ReadNullableInt(save, "count"),
            ["quality"] = ReadNullableInt(save, "quality"), ["qualityName"] = ReadString(Read(item, "tItemQualityData"), "name"),
            ["level"] = ReadNullableInt(save, "level"), ["forgeLevel"] = ReadNullableInt(save, "forgeLevel"),
            ["slotCount"] = ReadNullableInt(save, "slotCount"), ["mainAttributeValue"] = ReadNullableInt(save, "mainAttrValue"),
            ["position"] = Read(item, "posType")?.ToString(),
            ["iconKey"] = icon, ["iconUrl"] = IconUrl(icon),
            ["affixes"] = ReadList(Read(save, "affixList")).Select(DescribeSimpleObject).ToList(),
            ["runes"] = ReadList(Read(save, "slotRuneList")).Select(DescribeSimpleObject).ToList()
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

    private static void EmitCatalogOnce()
    {
        lock (StateLock) { if (catalogSent) return; catalogSent = true; }
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
        var skill = skillId is > 0 ? InvokeStatic("TableData", "getTSkillData", skillId.Value) : null;
        var infoId = ReadNullableInt(skill, "infoId");
        var info = infoId is > 0 ? InvokeStatic("TableData", "getTSkillInfoData", infoId.Value) : null;
        var icon = ReadString(row, "icon"); QueueIcon(icon);
        return new()
        {
            ["kind"] = "talent", ["id"] = ReadNullableInt(row, "id"), ["jobId"] = ReadNullableInt(row, "jobId"),
            ["name"] = ReadString(row, "name"), ["englishName"] = EnglishName(row, ReadString(row, "name")),
            ["description"] = ReadString(info, "des"), ["englishDescription"] = EnglishText(info, "_des", ReadString(info, "des")),
            ["skillId"] = skillId, ["masteryId"] = ReadNullableInt(row, "masteryId"),
            ["floor"] = ReadNullableInt(row, "floor"), ["iconKey"] = icon, ["iconUrl"] = IconUrl(icon)
        };
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
        lock (StateLock) if (KnownIcons.Add(key)) PendingIcons.Enqueue(key);
    }

    private static string? IconUrl(string? key) => string.IsNullOrWhiteSpace(key) ? null : "/assets/icons/" + IconFile(key);
    private static string IconFile(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant() + ".png";

    private static void ExportPendingIcons(int limit)
    {
        var directory = Path.Combine(Paths.BepInExRootPath, "PathOfIdleStats", "icons");
        Directory.CreateDirectory(directory);
        for (var count = 0; count < limit; count++)
        {
            string key;
            lock (StateLock) { if (PendingIcons.Count == 0) return; key = PendingIcons.Dequeue(); }
            var path = Path.Combine(directory, IconFile(key));
            if (File.Exists(path)) continue;
            try
            {
                var resMgr = ReadStatic("Game", "resMgr");
                var sprite = resMgr?.GetType().GetMethod("GetSprite")?.Invoke(resMgr, new object[] { key }) as Sprite;
                if (sprite is null) continue;
                var rect = sprite.textureRect;
                var pixels = sprite.texture.GetPixels((int)rect.x, (int)rect.y, (int)rect.width, (int)rect.height);
                var copy = new Texture2D((int)rect.width, (int)rect.height, TextureFormat.RGBA32, false);
                copy.SetPixels(pixels); copy.Apply();
                File.WriteAllBytes(path, ImageConversion.EncodeToPNG(copy));
                UnityEngine.Object.Destroy(copy);
            }
            catch (Exception error) { Instance?.Log.LogDebug($"Icon export skipped for {key}: {error.Message}"); }
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

    private static object? Read(object? value, string name)
    {
        if (value is null) return null;
        try { return value.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(value); }
        catch { return null; }
    }
    private static int ReadInt(object? value, string name) => Convert.ToInt32(Read(value, name) ?? 0, CultureInfo.InvariantCulture);
    private static int? ReadNullableInt(object? value, string name) => Read(value, name) is { } raw ? Convert.ToInt32(raw, CultureInfo.InvariantCulture) : null;
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
