using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using CUE4Parse;
using CUE4Parse.Compression;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.FileProvider.Objects;
using CUE4Parse.UE4.VirtualFileSystem;
using CUE4Parse_Conversion.Animations;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Options;
using Serilog;

// Read-only, local single-clip probe. The index command writes filenames only.
// Resource keys are supplied in a local file, never embedded or logged.
var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
for (var i = 1; i + 1 < args.Length; i += 2) options[args[i]] = args[i + 1];
if (args.Length == 0 || !options.TryGetValue("--paks", out var paks) ||
    !options.TryGetValue("--keys", out var keyFile) || !options.TryGetValue("--out", out var output))
    throw new ArgumentException("index|inspect --paks DIRECTORY --keys LOCAL_JSON --out DIRECTORY [--asset EXACT_PATH]");
Directory.CreateDirectory(output);
var watch = Stopwatch.StartNew();
Log.Logger = new LoggerConfiguration().MinimumLevel.Error().WriteTo.Console().CreateLogger();
CUE4ParseLog.UseLogger(Log.Logger);
var extraDirectories = options.TryGetValue("--patch", out var patch) ? new[] { new DirectoryInfo(patch) } : [];
using var provider = new DefaultFileProvider(new DirectoryInfo(paks), extraDirectories, SearchOption.TopDirectoryOnly,
    new VersionContainer(EGame.GAME_WutheringWaves), StringComparer.OrdinalIgnoreCase);
provider.Initialize();
provider.Mount();
using var keyJson = JsonDocument.Parse(File.ReadAllText(keyFile));
var keys = new Dictionary<FGuid, FAesKey>();
if (keyJson.RootElement.TryGetProperty("mainKey", out var main)) keys[new FGuid()] = new FAesKey(main.GetString()!);
foreach (var entry in keyJson.RootElement.GetProperty("dynamicKeys").EnumerateArray())
    keys[new FGuid(entry.GetProperty("guid").GetString()!.Replace("-", ""))] = new FAesKey(entry.GetProperty("key").GetString()!);
await provider.SubmitKeysAsync(keys);
var summary = new { mounted = provider.MountedVfs.Count, unmounted = provider.UnloadedVfs.Count,
    files = provider.Files.Count, elapsedMs = watch.ElapsedMilliseconds };
Console.WriteLine(JsonSerializer.Serialize(summary));
File.WriteAllText(Path.Combine(output, "mount-summary.json"), JsonSerializer.Serialize(summary));
if (provider.Files.Count == 0) throw new InvalidOperationException("No resource index could be mounted.");

if (args[0] == "index")
{
    var paths = provider.Files.Keys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray();
    File.WriteAllLines(Path.Combine(output, "resource-index.txt"), paths);
    var selected = paths.Where(x => Regex.IsMatch(x, "aemeath|aimisi|爱弥斯", RegexOptions.IgnoreCase)).ToArray();
    File.WriteAllLines(Path.Combine(output, "character-candidates.txt"), selected);
    Console.WriteLine($"Character-name candidates: {selected.Length}");
    foreach (var item in selected.Take(40)) Console.WriteLine(item);
}
else if (args[0] is "inspect" or "export-one")
{
    if (!options.TryGetValue("--asset", out var asset) || asset.Contains('*'))
        throw new ArgumentException("Exactly one --asset path is required.");
    await OodleHelper.InitializeAsync();
    provider.LoadVirtualPaths();
    var package = provider.LoadPackage(asset);
    var objects = package.GetExports().ToArray();
    Console.WriteLine(string.Join("\n", objects.Select(x => $"{x.Name}: {x.ExportType}")));
    File.WriteAllText(Path.Combine(output, "single-asset-properties.json"),
        Newtonsoft.Json.JsonConvert.SerializeObject(objects, Newtonsoft.Json.Formatting.Indented));
    if (args[0] == "export-one")
    {
        var anim = objects.OfType<UAnimSequence>().Single();
        if (anim.AdditiveAnimType != EAdditiveAnimationType.AAT_None)
            throw new NotSupportedException("This single-clip pilot requires a full-pose, non-additive animation.");
        var set = anim.ConvertAnims();
        var sequence = set.Sequences.Single();
        var skeleton = set.Skeleton.ReferenceSkeleton;
        var bones = skeleton.FinalRefBoneInfo.Select((b, i) => new {
            name = b.Name.Text, parent = b.ParentIndex,
            p = V(skeleton.FinalRefBonePose[i].Translation),
            q = Q(skeleton.FinalRefBonePose[i].Rotation),
            s = V(skeleton.FinalRefBonePose[i].Scale3D)
        }).ToArray();
        var frames = new List<object>();
        for (var frame = 0; frame < sequence.NumFrames; frame++)
        {
            var transforms = new List<object>();
            for (var i = 0; i < bones.Length; i++)
            {
                var rest = skeleton.FinalRefBonePose[i];
                var p = rest.Translation; var q = rest.Rotation; var s = rest.Scale3D;
                if (i < sequence.Tracks.Count && sequence.Tracks[i].HasKeys())
                {
                    sequence.Tracks[i].GetBoneTransform(frame, sequence.NumFrames, ref q, ref p, ref s);
                    sequence.RetargetBoneTransform(i, rest, ref q, ref p, ref s);
                }
                transforms.Add(new { p = V(p), q = Q(q), s = V(s) });
            }
            frames.Add(transforms);
        }
        var file = provider.Files[asset];
        var clip = new { schema = 1, name = anim.Name, sourceAsset = asset,
            sourceArchive = file is VfsEntry vfs ? Path.GetFileName(vfs.Vfs.Path) : "loose",
            sourceSkeleton = set.Skeleton.Name, frameCount = sequence.NumFrames,
            duration = anim.SequenceLength, rateScale = anim.RateScale,
            sourceFrameRate = (sequence.NumFrames - 1) / anim.SequenceLength,
            compression = anim.CompressedDataStructure?.GetType().Name,
            additive = false, units = "Unreal centimeters; native axes; local bone transforms",
            bones, frames };
        File.WriteAllText(Path.Combine(output, "native-clip.json"), JsonSerializer.Serialize(clip));
        Console.WriteLine($"Exported one clip: {anim.Name}, {sequence.NumFrames} frames, {bones.Length} bones, {anim.SequenceLength:F3} seconds");
        if (options.TryGetValue("--mesh", out var meshPath))
        {
            if (meshPath.Contains('*')) throw new ArgumentException("Exactly one companion mesh is allowed.");
            var mesh = provider.LoadPackage(meshPath).GetExports().OfType<USkeletalMesh>().Single();
            var session = new ExportSession(); session.Add(mesh);
            var results = await session.RunAsync(Path.Combine(output, "source-mesh"),
                new ExportOptions(meshFormat: EMeshFormat.Gltf2, exportMaterials: false, exportMorphTargets: false));
            Console.WriteLine(Newtonsoft.Json.JsonConvert.SerializeObject(results));
        }
    }
}
else throw new ArgumentException("Unknown command.");

static float[] V(CUE4Parse.UE4.Objects.Core.Math.FVector v) => [v.X, v.Y, v.Z];
static float[] Q(CUE4Parse.UE4.Objects.Core.Math.FQuat q) => [q.X, q.Y, q.Z, q.W];
