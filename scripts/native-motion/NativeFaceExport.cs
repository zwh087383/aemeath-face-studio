using System.Text.Json;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Objects.Engine.Animation;
using CUE4Parse.UE4.Objects.Engine.Curves;
using Newtonsoft.Json.Linq;

// Optional companion to NativeMotionProbe. Raw game data stays in the local
// output directory. This exporter does not manufacture presets from filenames.
public static class NativeFaceExport
{
    public static object Export(DefaultFileProvider provider, string asset, string outputPath)
    {
        if (asset.Contains('*')) throw new ArgumentException("An exact face asset path is required.");
        var objects = provider.LoadPackage(asset).GetExports().ToArray();
        return ExportObjects(objects, asset, outputPath);
    }

    public static object ExportObjects(UObject[] objects, string asset, string outputPath)
    {
        var raw = JToken.Parse(Newtonsoft.Json.JsonConvert.SerializeObject(objects));
        var curves = new List<object>();
        var poses = new List<object>();
        var warnings = new List<string>();
        var scalarParameters = new List<object>();
        float duration = 0;
        foreach (var obj in objects)
        {
            if (obj is UAnimSequence sequence)
            {
                duration = Math.Max(duration, sequence.SequenceLength);
                var values = sequence.CompressedCurveData?.FloatCurves ?? sequence.RawCurveData?.FloatCurves;
                foreach (var curve in values ?? [])
                {
                    curves.Add(Curve(curve.CurveName.Text, curve.FloatCurve, sequence.Name));
                }
                if (sequence.CompressedCurveByteStream is { Length: > 0 } && values == null)
                    warnings.Add($"{sequence.Name}: compressed curve bytes exist but the codec did not provide float curves ({sequence.CurveCodecPath}).");
            }
            if (obj is UPoseAsset pose)
            {
                var container = pose.PoseContainer;
                if (container == null) { warnings.Add($"{pose.Name}: PoseContainer unavailable."); continue; }
                var names = container.GetPoseNames().ToArray();
                var tracks = container.Tracks.Select(x => x.Text).ToArray();
                var curveNames = container.Curves.Select(x => x.CurveName.Text).ToArray();
                var values = container.Poses ?? [];
                for (var index = 0; index < values.Length; index++)
                {
                    var value = values[index];
                    var transforms = value.LocalSpacePose ?? [];
                    var curveValues = value.CurveData ?? [];
                    poses.Add(new { exportName = pose.Name, index,
                        name = index < names.Length ? names[index] : null,
                        additive = pose.bAdditivePose, basePoseIndex = pose.BasePoseIndex,
                        tracks, trackToBufferIndex = value.TrackToBufferIndex,
                        transforms = transforms.Select(t => new {
                            p = new[] { t.Translation.X, t.Translation.Y, t.Translation.Z },
                            q = new[] { t.Rotation.X, t.Rotation.Y, t.Rotation.Z, t.Rotation.W },
                            s = new[] { t.Scale3D.X, t.Scale3D.Y, t.Scale3D.Z } }).ToArray(),
                        curves = curveValues.Select((v, i) => new {
                            name = i < curveNames.Length ? curveNames[i] : null, value = v }).ToArray() });
                }
            }
        }

        // Tagged data assets (including custom game structs) are also retained.
        // A curve is recognized by serialized time/value keys, never by a label.
        Scan(raw, "$", curves, scalarParameters);
        var data = new { schema = 1, sourceAsset = asset,
            exportTypes = objects.Select(x => new { name = x.Name, type = x.ExportType,
                frames = x is UAnimSequence a ? (int?)a.NumFrames : null,
                additiveType = x is UAnimSequence b ? b.AdditiveAnimType.ToString() : null,
                skeletonGuid = x is UAnimSequence c ? c.SkeletonGuid.ToString() : null }).ToArray(),
            duration, curves, poses, scalarParameters, warnings,
            evidence = "Native serialized parameters and decoded curves; unsupported channels are preserved without invented facial weights.",
            raw = System.Text.Json.JsonSerializer.Deserialize<JsonElement>(raw.ToString(Newtonsoft.Json.Formatting.None)) };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
        File.WriteAllText(outputPath, JsonSerializer.Serialize(data));
        return new { sourceAsset = asset, outputFile = Path.GetFileName(outputPath),
            exports = objects.Length, curves = curves.Count, poses = poses.Count,
            scalarParameters = scalarParameters.Count, warnings };
    }

    private static object Curve(string name, FRichCurve curve, string exportName) => new {
        name, exportName, origin = "decoded-float-curve",
        defaultValue = Math.Abs(curve.DefaultValue) < 1e30f ? (float?)curve.DefaultValue : null,
        preInfinity = curve.PreInfinityExtrap.ToString(), postInfinity = curve.PostInfinityExtrap.ToString(),
        keys = curve.Keys.Select(k => new { time = k.Time, value = k.Value,
            interpolation = k.InterpMode.ToString(), tangentMode = k.TangentMode.ToString(),
            tangentWeightMode = k.TangentWeightMode.ToString(),
            arriveTangent = k.ArriveTangent, leaveTangent = k.LeaveTangent,
            arriveTangentWeight = k.ArriveTangentWeight, leaveTangentWeight = k.LeaveTangentWeight }).ToArray() };

    private static void Scan(JToken token, string path, List<object> curves, List<object> scalars)
    {
        if (token is JObject obj)
        {
            if (obj["Keys"] is JArray keys && keys.Count > 0 && keys.All(x =>
                (x["Time"]?.Type is JTokenType.Float or JTokenType.Integer) &&
                (x["Value"]?.Type is JTokenType.Float or JTokenType.Integer)))
            {
                var parent = obj.Parent?.Parent as JObject;
                var name = parent?["CurveName"]?.ToString() ?? parent?["Name"]?.ToString();
                curves.Add(new { name, path, origin = "serialized-rich-curve",
                    defaultValue = FiniteValue(obj["DefaultValue"]),
                    preInfinity = obj["PreInfinityExtrap"]?.ToString(), postInfinity = obj["PostInfinityExtrap"]?.ToString(),
                    keys = keys.Select(k => new {
                        time = k["Time"]!.Value<double>(), value = k["Value"]!.Value<double>(),
                        interpolation = k["InterpMode"]?.ToString() ?? "RCIM_Linear",
                        tangentMode = k["TangentMode"]?.ToString(), tangentWeightMode = k["TangentWeightMode"]?.ToString(),
                        arriveTangent = k["ArriveTangent"]?.Value<double>() ?? 0,
                        leaveTangent = k["LeaveTangent"]?.Value<double>() ?? 0,
                        arriveTangentWeight = k["ArriveTangentWeight"]?.Value<double>() ?? 0,
                        leaveTangentWeight = k["LeaveTangentWeight"]?.Value<double>() ?? 0 }).ToArray() });
                return;
            }
            foreach (var property in obj.Properties())
            {
                // UAnimSequence curve fields were decoded with typed APIs above.
                if (obj["Type"]?.ToString() == "AnimSequence" && (property.Name is "CompressedCurveData" or "RawCurveData")) continue;
                Scan(property.Value, path + "." + property.Name, curves, scalars);
            }
        }
        else if (token is JArray array)
            for (var i = 0; i < array.Count; i++) Scan(array[i], path + "[" + i + "]", curves, scalars);
        else if (token.Type is JTokenType.Float or JTokenType.Integer)
        {
            var value = token.Value<double>();
            if (double.IsFinite(value)) scalars.Add(new { path, value });
        }
    }

    private static double? FiniteValue(JToken? token)
    {
        if (token == null || token.Type is not (JTokenType.Float or JTokenType.Integer)) return null;
        var value = token.Value<double>();
        return double.IsFinite(value) && Math.Abs(value) < 1e30 ? value : null;
    }
}
