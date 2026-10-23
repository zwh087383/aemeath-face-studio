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
using System.IO.Compression;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;

// Read-only local probe with explicit per-asset allowlists. Index writes names only.
// Resource keys are supplied in a local file, never embedded or logged.
var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
for (var i = 1; i + 1 < args.Length; i += 2) options[args[i]] = args[i + 1];
if (args.Length == 0 || !options.TryGetValue("--paks", out var paks) ||
    !options.TryGetValue("--keys", out var keyFile) || !options.TryGetValue("--out", out var output))
    throw new ArgumentException("index|inspect|inspect-list|export-one|export-list|export-complete --paks DIRECTORY --keys LOCAL_JSON --out DIRECTORY [--asset EXACT_PATH | --manifest ALLOWLIST_JSON]");
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
        var clip = DecodeClip(anim, provider, asset);
        File.WriteAllText(Path.Combine(output, "native-clip.json"), JsonSerializer.Serialize(clip.Data));
        Console.WriteLine($"Exported one clip: {anim.Name}, {clip.Frames} frames, {clip.Bones} bones, {anim.SequenceLength:F3} seconds");
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
else if (args[0] == "inspect-list")
{
    if (!options.TryGetValue("--manifest", out var inspectList)) throw new ArgumentException("Explicit inspect --manifest required.");
    using var list=JsonDocument.Parse(File.ReadAllText(inspectList));
    var entries=list.RootElement.GetProperty("objects").EnumerateArray().Select(x=>x.Clone()).ToArray();
    if(entries.Length>80)throw new ArgumentException("Inspect-list is for at most 80 representative objects.");
    await OodleHelper.InitializeAsync();provider.LoadVirtualPaths();
    var results=new List<object>();
    foreach(var entry in entries)
    {
        var id=entry.GetProperty("id").GetString()!;var source=entry.GetProperty("sourceAsset").GetString()!;
        if(!Regex.IsMatch(id,"^[a-z][a-z0-9-]{0,79}$")||source.Contains('*'))throw new ArgumentException("Invalid inspect entry.");
        try{
            var objects=provider.LoadPackage(source).GetExports().ToArray();
            File.WriteAllText(Path.Combine(output,id+".json"),Newtonsoft.Json.JsonConvert.SerializeObject(objects,Newtonsoft.Json.Formatting.Indented));
            results.Add(new{id,sourceAsset=source,exports=objects.Select(o=>new{name=o.Name,type=o.ExportType})});
            Console.WriteLine(id+": "+string.Join(", ",objects.Select(o=>o.ExportType)));
        }catch(Exception error){results.Add(new{id,sourceAsset=source,error=error.Message});Console.WriteLine(id+": "+error.GetType().Name);}
    }
    File.WriteAllText(Path.Combine(output,"inspect-summary.json"),JsonSerializer.Serialize(results));
}
else if (args[0] == "export-complete")
{
    if(!options.TryGetValue("--manifest",out var completeList))throw new ArgumentException("An explicit complete allowlist is required.");
    using var list=JsonDocument.Parse(File.ReadAllText(completeList));
    var entries=list.RootElement.GetProperty("clips").EnumerateArray().Concat(list.RootElement.GetProperty("objects").EnumerateArray()).Select(e=>e.Clone()).ToArray();
    if(entries.Length>10000)throw new ArgumentException("Too many reviewed assets.");
    var seen=new HashSet<string>();
    foreach(var e in entries){var id=e.GetProperty("id").GetString()!;if(!Regex.IsMatch(id,"^[a-z][a-z0-9-]{0,100}$")||!seen.Add(id)||e.GetProperty("sourceAsset").GetString()!.Contains('*'))throw new ArgumentException("Invalid reviewed asset.");}
    await OodleHelper.InitializeAsync();provider.LoadVirtualPaths();
    foreach(var sub in new[]{"raw","clips","resources","models","materials"})Directory.CreateDirectory(Path.Combine(output,sub));
    var releasedClips=new List<Dictionary<string,object?>>();var resources=new List<Dictionary<string,object?>>();var failures=new List<object>();
    var partial=Path.Combine(output,"manifest.partial.json");var completed=new Dictionary<string,Dictionary<string,object?>>();
    // A completed manifest can contain entries beyond the last interval save.
    // Merge it before the newer checkpoint, rather than re-exporting good data.
    foreach(var priorFile in new[]{Path.Combine(output,"manifest.json"),partial}.Where(File.Exists)){
        using var prior=JsonDocument.Parse(File.ReadAllText(priorFile));
        foreach(var e in prior.RootElement.GetProperty("clips").EnumerateArray().Concat(prior.RootElement.GetProperty("resources").EnumerateArray()))
            completed[e.GetProperty("id").GetString()!]=e.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value.Clone());
    }
    var counter=0;
    foreach(var entry in entries)
    {
        var id=entry.GetProperty("id").GetString()!;var source=entry.GetProperty("sourceAsset").GetString()!;
        var isClip=entry.TryGetProperty("resourceKind",out var resourceKind);var kind=isClip?resourceKind.GetString()!:entry.GetProperty("kind").GetString()!;
        var row=entry.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value.Clone());
        if(completed.TryGetValue(id,out var priorRow)&&priorRow.TryGetValue("status",out var state)&&state?.ToString() is "ready" or "decoded" or "archived"){
            if(priorRow.GetValueOrDefault("sourceAsset")?.ToString()!=source)throw new InvalidOperationException("Checkpoint source differs from the reviewed asset: "+id);
            var priorFile=priorRow.GetValueOrDefault("file")?.ToString();
            if(priorFile!=null&&!File.Exists(Path.Combine(output,priorFile)))throw new InvalidOperationException("Checkpoint data file is missing: "+id);
            if(!Directory.Exists(Path.Combine(output,"raw",id)))throw new InvalidOperationException("Checkpoint original package is missing: "+id);
            (isClip?releasedClips:resources).Add(priorRow);counter++;continue;
        }
        try{
            // The parent Weapon folder also stores ordinary props; filter the
            // actual filename, never reject a paper plane merely by its parent.
            var baseName=Path.GetFileNameWithoutExtension(source);
            if(Regex.IsMatch(baseName,"attack|skill|burst|execute|dodge|death|beh(it)|weapon|rogue|captured|manipulate|summon",RegexOptions.IgnoreCase))throw new NotSupportedException("Combat filename rejected.");
            var rawDir=Path.Combine(output,"raw",id);Directory.CreateDirectory(rawDir);
            var rawFiles=new List<object>();
            foreach(var item in provider.SavePackage(source)){
                var name=Path.GetFileName(item.Key);File.WriteAllBytes(Path.Combine(rawDir,name),item.Value);
                rawFiles.Add(new {name,bytes=item.Value.Length,sha256=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(item.Value)).ToLowerInvariant()});
            }
            row["rawFiles"]=rawFiles;row["rawArchived"]=true;
            var objects=provider.LoadPackage(source).GetExports().ToArray();row["exportTypes"]=objects.Select(o=>o.ExportType).Distinct().ToArray();
            if(isClip){
                var anim=objects.OfType<UAnimSequence>().Single();
                var clip=DecodeClip(anim,provider,source,true);
                var file=Path.Combine(output,"clips",id+".json.gz");
                using(var stream=File.Create(file))using(var packed=new GZipStream(stream,CompressionLevel.Fastest))JsonSerializer.Serialize(packed,clip.Data);
                row["file"]="clips/"+id+".json.gz";row["duration"]=anim.SequenceLength;row["frameCount"]=clip.Frames;row["boneCount"]=clip.Bones;row["sourceSkeleton"]=clip.Skeleton;
                row["sourceAdditiveType"]=anim.AdditiveAnimType.ToString();row["status"]="ready";
            }else{
                row["parseSummary"]=NativeFaceExport.ExportObjects(objects,source,Path.Combine(output,"resources",id+".json"));
                row["file"]="resources/"+id+".json";row["status"]="decoded";
                if(kind is "prop-model" or "material"){
                    var session=new ExportSession();var count=0;
                    foreach(var obj in objects)if(obj is USkeletalMesh or UStaticMesh or UMaterialInterface){session.Add(obj);count++;}
                    if(count>0){
                        var modelDir=Path.Combine(output,kind=="prop-model"?"models":"materials",id);
                        var exportResults=await session.RunAsync(modelDir,new ExportOptions(meshFormat:EMeshFormat.Gltf2,exportMaterials:true,exportMorphTargets:true));
                        row["conversionResults"]=System.Text.Json.JsonSerializer.Deserialize<JsonElement>(Newtonsoft.Json.JsonConvert.SerializeObject(exportResults));
                        var paths=Directory.GetFiles(modelDir,"*",SearchOption.AllDirectories).Select(p=>Path.GetRelativePath(output,p).Replace('\\','/')).ToArray();row["convertedFiles"]=paths;
                        var model=paths.FirstOrDefault(p=>p.EndsWith(".glb",StringComparison.OrdinalIgnoreCase));
                        if(model!=null){row["modelFile"]=model;row["modelUrl"]="/native-resources-data/models/"+id+".glb";row["status"]="ready";}
                    }
                }
            }
        }catch(Exception error){
            row["status"]=row.ContainsKey("rawArchived")?"archived":"failed";row["error"]=error.Message;
            failures.Add(new{id,sourceAsset=source,error=error.Message,rawArchived=row.ContainsKey("rawArchived")});
            if(!isClip&&!row.ContainsKey("file")){
                File.WriteAllText(Path.Combine(output,"resources",id+".json"),JsonSerializer.Serialize(new{schema=1,sourceAsset=source,error=error.Message,rawArchived=row.ContainsKey("rawArchived")}));row["file"]="resources/"+id+".json";
            }
        }
        (isClip?releasedClips:resources).Add(row);counter++;
        if(counter%25==0||counter==entries.Length){
            var snapshot=JsonSerializer.Serialize(new{schema=1,experimental=true,clips=releasedClips,resources});WriteCheckpoint(partial,snapshot);
            Console.WriteLine($"PROGRESS {counter}/{entries.Length}: {id} {row["status"]}");GC.Collect();
        }
    }
    var completeSnapshot=JsonSerializer.Serialize(new{schema=1,experimental=true,clips=releasedClips,resources});
    WriteCheckpoint(partial,completeSnapshot);WriteCheckpoint(Path.Combine(output,"manifest.json"),completeSnapshot);
    // Include unresolved rows carried over from checkpoints in the final receipt.
    var unresolved=releasedClips.Concat(resources).Where(r=>r.TryGetValue("status",out var status)&&status?.ToString() is "archived" or "failed").Select(r=>new{id=r["id"],sourceAsset=r["sourceAsset"],error=r.GetValueOrDefault("error"),rawArchived=r.GetValueOrDefault("rawArchived")}).ToArray();
    File.WriteAllText(Path.Combine(output,"export-results.json"),JsonSerializer.Serialize(new{requested=entries.Length,clips=releasedClips.Count,resources=resources.Count,failures=unresolved}));
    Console.WriteLine($"COMPLETE {counter} assets; {unresolved.Length} unresolved parsing/conversion issues.");
}
else if (args[0] == "export-list")
{
    if (!options.TryGetValue("--manifest", out var allowlist)) throw new ArgumentException("An explicit --manifest allowlist is required.");
    if (File.Exists(Path.Combine(output, "manifest.json"))) throw new InvalidOperationException("Preserve earlier evidence: use a new output directory.");
    using var list = JsonDocument.Parse(File.ReadAllText(allowlist));
    var entries = list.RootElement.GetProperty("clips").EnumerateArray().Select(x=>x.Clone()).ToArray();
    if (entries.Length is < 1 or > 160) throw new ArgumentException("The reviewed common-motion allowlist must contain 1–160 clips.");
    var ids = new HashSet<string>(StringComparer.Ordinal);
    foreach (var entry in entries)
    {
        var id = entry.GetProperty("id").GetString()!;
        var source = entry.GetProperty("sourceAsset").GetString()!;
        if (!Regex.IsMatch(id, "^[a-z][a-z0-9-]{0,79}$") || !ids.Add(id) || source.Contains('*')) throw new ArgumentException("Invalid or duplicate clip id/path.");
        if (Regex.IsMatch(source, "attack|skill|burst|execute|dodge|death|weapon|fight|rogue|(?:^|[/_])hit(?:[_0-9.]|$)", RegexOptions.IgnoreCase))
            throw new ArgumentException("Combat asset rejected by common-motion allowlist guard.");
    }
    await OodleHelper.InitializeAsync();provider.LoadVirtualPaths();
    Directory.CreateDirectory(Path.Combine(output, "clips"));
    var ready = new List<Dictionary<string, object?>>();var rejected = new List<object>();
    foreach (var entry in entries)
    {
        var id = entry.GetProperty("id").GetString()!;var source = entry.GetProperty("sourceAsset").GetString()!;
        try
        {
            var anim = provider.LoadPackage(source).GetExports().OfType<UAnimSequence>().Single();
            if (anim.SequenceLength > 30) throw new NotSupportedException("Long scene clip exceeds this common-motion batch's 30-second limit.");
            var clip = DecodeClip(anim, provider, source);
            var bytes = JsonSerializer.SerializeToUtf8Bytes(clip.Data);
            File.WriteAllBytes(Path.Combine(output, "clips", id + ".json"), bytes);
            var row = entry.EnumerateObject().ToDictionary(p=>p.Name,p=>(object?)p.Value.Clone());
            row["duration"] = anim.SequenceLength;row["frameCount"] = clip.Frames;row["boneCount"] = clip.Bones;row["sourceSkeleton"] = clip.Skeleton;
            row["status"] = "ready";row["sha256"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
            ready.Add(row);Console.WriteLine($"OK {id}: {anim.SequenceLength:F3}s, {clip.Frames} frames, {clip.Bones} bones");
        }
        catch (Exception error)
        {
            rejected.Add(new {id,sourceAsset=source,error=error.Message});Console.WriteLine($"SKIP {id}: {error.GetType().Name}");
        }
    }
    File.WriteAllText(Path.Combine(output,"manifest.json"),JsonSerializer.Serialize(new {schema=1,experimental=true,clips=ready}));
    File.WriteAllText(Path.Combine(output,"export-results.json"),JsonSerializer.Serialize(new {requested=entries.Length,ready=ready.Count,rejected}));
    Console.WriteLine($"Common-motion batch: {ready.Count}/{entries.Length} exported; {rejected.Count} rejected.");
}
else throw new ArgumentException("Unknown command.");

static (object Data, int Frames, int Bones, string Skeleton) DecodeClip(UAnimSequence anim, DefaultFileProvider provider, string asset, bool allowBakedAdditive = false)
{
    if (anim.AdditiveAnimType != EAdditiveAnimationType.AAT_None && !allowBakedAdditive)
        throw new NotSupportedException("Only full-pose non-additive animation is supported.");
    if(anim.AdditiveAnimType != EAdditiveAnimationType.AAT_None && !anim.IsValidAdditive())throw new NotSupportedException("Additive source has no valid base pose.");
    var set=anim.ConvertAnims();var sequence=set.Sequences.Single();var skeleton=set.Skeleton.ReferenceSkeleton;
    var bones=skeleton.FinalRefBoneInfo.Select((b,i)=>new {name=b.Name.Text,parent=b.ParentIndex,
        p=V(skeleton.FinalRefBonePose[i].Translation),q=Q(skeleton.FinalRefBonePose[i].Rotation),s=V(skeleton.FinalRefBonePose[i].Scale3D)}).ToArray();
    var frames=new List<object>();
    for(var frame=0;frame<sequence.NumFrames;frame++)
    {
        var transforms=new List<object>();
        for(var i=0;i<bones.Length;i++)
        {
            var rest=skeleton.FinalRefBonePose[i];var p=rest.Translation;var q=rest.Rotation;var s=rest.Scale3D;
            if(i<sequence.Tracks.Count&&sequence.Tracks[i].HasKeys())
            {
                sequence.Tracks[i].GetBoneTransform(frame,sequence.NumFrames,ref q,ref p,ref s);
                sequence.RetargetBoneTransform(i,rest,ref q,ref p,ref s);
            }
            transforms.Add(new {p=V(p),q=Q(q),s=V(s)});
        }
        frames.Add(transforms);
    }
    var file=provider.Files[asset];
    var data=new {schema=1,name=anim.Name,sourceAsset=asset,sourceArchive=file is VfsEntry vfs?Path.GetFileName(vfs.Vfs.Path):"loose",
        sourceSkeleton=set.Skeleton.Name,frameCount=sequence.NumFrames,duration=anim.SequenceLength,rateScale=anim.RateScale,
        sourceFrameRate=(sequence.NumFrames-1)/anim.SequenceLength,compression=anim.CompressedDataStructure?.GetType().Name,
        additive=false,units="Unreal centimeters; native axes; local bone transforms",bones,frames};
    if(anim.AdditiveAnimType!=EAdditiveAnimationType.AAT_None){
        var baked=System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(data))!;baked["sourceAdditiveType"]=anim.AdditiveAnimType.ToString();baked["additiveBakedToFullPose"]=true;
        return(baked,sequence.NumFrames,bones.Length,set.Skeleton.Name);
    }
    return(data,sequence.NumFrames,bones.Length,set.Skeleton.Name);
}

static float[] V(CUE4Parse.UE4.Objects.Core.Math.FVector v) => [v.X, v.Y, v.Z];
static float[] Q(CUE4Parse.UE4.Objects.Core.Math.FQuat q) => [q.X, q.Y, q.Z, q.W];
static void WriteCheckpoint(string file,string json){var temporary=file+".tmp";File.WriteAllText(temporary,json);File.Move(temporary,file,true);}
