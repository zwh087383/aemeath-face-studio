// Real decoded Unreal float curves -> the PMX's original morph identifiers.
// No emotion, expression, or viseme weights are inferred from an asset filename.
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const cubic = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
const mode = value => String(value ?? '').replace(/^R(?:CIM|CTWM|CCE)_/, '');

export const AEMEATH_NATIVE_MORPHS = Object.freeze({
  S_20:'真面目', B_Anger:'怒り', B_Happy:'にこり', B_Cheerful:'にこり2', B_Sad:'困る', B_Flat:'平行',
  B_Up_Add:'上', B_Down_Add:'下', B_Inside_Add:'中', B_AH_R:'怪訝右', B_AH_L:'怪訝左',
  E_Close:'まばたき', E_Close_L:'ウィンク２', E_Close_R:'ｳｨﾝｸ２右',
  E_Smile_R:'ウィンク右', E_Smile_L:'ウィンク', E_Anger:'ｷﾘｯ', S_18:'ごめん～', E_Sad:'垂れ目',
  E_Focus:'じと目2', E_Insipid:'じと目', E_Blephar:'笑い目', E_Stare:'びっくり',
  Pupil_Up:'up', Pupil_Down:'down', Pupil_R:'right', Pupil_L:'left', Pupil_Scale:'瞳小',
  S_01:'あ', I:'い', U:'う', E:'え', O:'お', S_15:'∧', S_16:'にやり', Aa:'口', A:'あ4',
  // The PMX also has combined two-sided morphs with these English names.
  // Native _R/_L channels must select the actual half-face morphs instead.
  M_Smile_R:'右口角上げ', M_Smile_L:'左口角上げ', M_Ennui_R:'右口角下げ', M_Ennui_L:'左口角下げ',
  P_M_R_Add:'右口横広げ', P_M_L_Add:'左口横広げ', P_M_Scale_Add:'口横狭め',
  S_09:'てへぺろ', P_M_Up_Add:'口上', P_M_Down_Add:'口下', P_M_RMove_Add:'口右', P_M_LMove_Add:'口左',
  P_M_MidPoint_Add:'lip thin', P_M_UpDownView_Add:'口後', M_OpenSmall:'い3', M_Laugh:'いい',
  M_Scared:'д', M_ScaredTooth:'い2', C_M_Distant:'lip thick', S_02:'いい4', S_03:'いい5',
  S_04:'う2', S_05:'平口', S_06:'lip back2', S_07:'lip thick2', S_08:'う3', S_11:'いい6',
  S_12:'口2', S_13:'д2', S_14:'い4', S_17:'∧2', S_19:'垂れ目３', S_24:'歯上げ', S_25:'歯下げ',
  S_26:'舌上', S_27:'舌下', S_28:'lip thin3', S_29:'口左斜', S_30:'口右斜',
  M_Anger:'(○｀ε´○)', M_Trapezoid:'あ２', M_O:'お2', M_A:'あ3', M_Nutcracker:'M',
  P_M_ZR_Add:'右口角上げ2', P_M_ZL_Add:'左口角上げ2',
  C_ZR_Face:'C_ZR_Face', C_ZL_Face:'C_ZL_Face', C_Down_Face:'C_Down_Face', C_Up_Face:'C_Up_Face',
  P_Nose_Up:'鼻上', P_Nose_Down:'鼻下', S_10:'眉没',
  Scda_Head01:'組合_kaixin', Scda_Head02:'組合_kaixin2', Scda_Head03:'組合_ee', Scda_Head04:'組合_O_0?',
  Scda_Head05:'組合_uu', Scda_Head06:'組合_heihei', Scda_Head07:'組合_ei~', Scda_Head08:'組合_en?',
  Scda_Head09:'組合_mumu~', Scda_Hiar01:'髮調整',
});

function keyData(key) {
  const time = Number(key.time ?? key.Time), value = Number(key.value ?? key.Value);
  if (!Number.isFinite(time) || !Number.isFinite(value)) throw Error('Native curve contains an invalid key');
  return {time, value, interpolation:mode(key.interpolation ?? key.InterpMode ?? 'RCIM_Linear'),
    tangentWeightMode:mode(key.tangentWeightMode ?? key.TangentWeightMode ?? 'RCTWM_WeightedNone'),
    arriveTangent:finite(key.arriveTangent ?? key.ArriveTangent), leaveTangent:finite(key.leaveTangent ?? key.LeaveTangent),
    arriveTangentWeight:finite(key.arriveTangentWeight ?? key.ArriveTangentWeight),
    leaveTangentWeight:finite(key.leaveTangentWeight ?? key.LeaveTangentWeight)};
}

function curveData(curve, fallbackName) {
  const source = curve.FloatCurve ?? curve;
  const keys = (source.keys ?? source.Keys ?? []).map(keyData).sort((a, b) => a.time - b.time);
  const defaultValue = finite(source.defaultValue ?? source.DefaultValue);
  return {name:curve.name ?? curve.CurveName ?? fallbackName ?? null, keys,
    defaultValue:Math.abs(defaultValue) < 1e30 ? defaultValue : 0,
    preInfinity:mode(curve.preInfinity ?? source.PreInfinityExtrap ?? 'RCCE_Constant'),
    postInfinity:mode(curve.postInfinity ?? source.PostInfinityExtrap ?? 'RCCE_Constant')};
}

export function readNativeExpression(data) {
  if (!data || typeof data !== 'object') throw Error('Native expression data is required');
  let duration = finite(data.duration), curves = [], names = [], additiveTypes = [];
  if (Array.isArray(data.curves)) {
    curves = data.curves.map(curve => curveData(curve));
    names = (data.exportTypes ?? []).map(x => x.name);
    additiveTypes = (data.exportTypes ?? []).map(x => x.additiveType).filter(Boolean);
  } else {
    const raw = data.raw ?? data;
    const exports = Array.isArray(raw) ? raw : raw.exports ?? [raw];
    for (const item of exports) {
      if (item.Type !== 'AnimSequence' && item.type !== 'AnimSequence') continue;
      const props = item.Properties ?? item.properties ?? {};
      duration = Math.max(duration, finite(props.SequenceLength));
      names.push(item.Name ?? item.name);
      if (props.AdditiveAnimType) additiveTypes.push(props.AdditiveAnimType);
      const values = item.CompressedCurveData?.FloatCurves ?? props.RawCurveData?.FloatCurves ?? item.RawCurveData?.FloatCurves ?? [];
      const curveNames = item.CompressedCurveNames ?? [];
      curves.push(...values.map((curve, i) => curveData(curve, curveNames[i]?.DisplayName)));
    }
  }
  const warnings = [...(data.warnings ?? [])];
  const seen = new Set();
  curves = curves.filter(curve => {
    if (typeof curve.name !== 'string' || !curve.name.length) {
      warnings.push('Unnamed serialized curve preserved as raw data and omitted from morph playback.');return false;
    }
    if (seen.has(curve.name)) { warnings.push(`Duplicate curve ${curve.name} omitted from morph playback.`);return false; }
    seen.add(curve.name);return true;
  });
  for (const curve of curves) if (curve.keys.length) duration = Math.max(duration, curve.keys.at(-1).time);
  return {sourceAsset:data.sourceAsset ?? null, names, duration, curves, additiveTypes, warnings};
}

function segment(a, b, time) {
  const dt = b.time - a.time;
  if (dt <= 0 || a.interpolation === 'Constant') return a.value;
  const t = Math.max(0, Math.min(1, (time - a.time) / dt));
  if (a.interpolation === 'Linear') return a.value + (b.value - a.value) * t;
  const leaveWeighted = ['WeightedLeave', 'WeightedBoth'].includes(a.tangentWeightMode);
  const arriveWeighted = ['WeightedArrive', 'WeightedBoth'].includes(b.tangentWeightMode);
  if (!leaveWeighted && !arriveWeighted) {
    return cubic(a.value, a.value + a.leaveTangent * dt / 3, b.value - b.arriveTangent * dt / 3, b.value, t);
  }
  const leaveAngle = Math.atan(a.leaveTangent), arriveAngle = Math.atan(b.arriveTangent);
  const leaveLength = leaveWeighted ? a.leaveTangentWeight : Math.hypot(dt, a.leaveTangent * dt) / 3;
  const arriveLength = arriveWeighted ? b.arriveTangentWeight : Math.hypot(dt, b.arriveTangent * dt) / 3;
  const x1 = Math.cos(leaveAngle) * leaveLength / dt, x2 = 1 - Math.cos(arriveAngle) * arriveLength / dt;
  // Locate every crossing and choose the largest root, matching UE's rule for
  // weighted Bezier tangents whose time control points can fold backward.
  let root = 0, lastX = -t, lastT = 0;
  for (let i = 1; i <= 64; i++) {
    const edge = i / 64, x = cubic(0, x1, x2, 1, edge) - t;
    if (lastX * x <= 0) {
      let lo = lastT, hi = edge, lowX = lastX;
      for (let j = 0; j < 32; j++) {
        const middle = (lo + hi) / 2, middleX = cubic(0, x1, x2, 1, middle) - t;
        if (lowX * middleX <= 0) hi = middle; else { lo = middle;lowX = middleX; }
      }
      root = (lo + hi) / 2;
    }
    lastT = edge;lastX = x;
  }
  return cubic(a.value, a.value + Math.sin(leaveAngle) * leaveLength,
    b.value - Math.sin(arriveAngle) * arriveLength, b.value, root);
}

export function evaluateNativeCurve(curve, inputTime) {
  const keys = curve.keys;
  if (!keys.length) return curve.defaultValue;
  if (keys.length === 1) return keys[0].value;
  let time = finite(inputTime), offset = 0;
  const first = keys[0], last = keys.at(-1), span = last.time - first.time;
  if (time < first.time || time > last.time) {
    const pre = time < first.time, extrapolation = pre ? curve.preInfinity : curve.postInfinity;
    if (extrapolation === 'Linear') {
      const a = pre ? first : keys.at(-2), b = pre ? keys[1] : last;
      return (pre ? first.value : last.value) + (time - (pre ? first.time : last.time)) * (b.value - a.value) / (b.time - a.time || 1);
    }
    if (span > 0 && ['Cycle', 'CycleWithOffset', 'Oscillate'].includes(extrapolation)) {
      const cycles = Math.floor((time - first.time) / span);
      time = first.time + ((time - first.time) % span + span) % span;
      if (extrapolation === 'CycleWithOffset') offset = cycles * (last.value - first.value);
      if (extrapolation === 'Oscillate' && Math.abs(cycles % 2) === 1) time = last.time - (time - first.time);
    } else return (pre ? first.value : last.value);
  }
  if (time <= first.time) return first.value + offset;
  if (time >= last.time) return last.value + offset;
  let lo = 0, hi = keys.length - 1;
  while (lo + 1 < hi) { const middle = (lo + hi) >> 1;if (keys[middle].time <= time) lo = middle; else hi = middle; }
  return segment(keys[lo], keys[hi], time) + offset;
}

export class NativeExpression {
  constructor(data) { this.data = readNativeExpression(data);this.duration = this.data.duration; }
  sample(time, {loop = false} = {}) {
    if (loop && this.duration > 0) time = ((time % this.duration) + this.duration) % this.duration;
    return Object.fromEntries(this.data.curves.map(curve => [curve.name, evaluateNativeCurve(curve, time)]));
  }
}

export class NativeExpressionBinding {
  constructor(dictionaryOrMesh) {
    this.dictionary = dictionaryOrMesh.morphTargetDictionary ?? dictionaryOrMesh;
    if (!this.dictionary || typeof this.dictionary !== 'object') throw Error('PMX morph dictionary is required');
    this.previous = new Set();
  }
  resolve(name) {
    const alias = AEMEATH_NATIVE_MORPHS[name];
    const targetName = alias && Object.hasOwn(this.dictionary, alias) ? alias : name;
    const index = this.dictionary[targetName];
    return Number.isInteger(index) && index >= 0 ? {index, targetName} : null;
  }
  apply(mesh, weights, {reset = true, clamp = false} = {}) {
    if (!mesh.morphTargetInfluences) throw Error('PMX morph influences are unavailable');
    if (reset) for (const index of this.previous) mesh.morphTargetInfluences[index] = 0;
    this.previous.clear();
    const mapped = [], unknown = [], control = [];
    for (const [name, input] of Object.entries(weights)) {
      const value = Number(input);
      if (!Number.isFinite(value)) throw Error(`Non-finite native weight: ${name}`);
      if (name === 'SeqMouthAlpha') { control.push({name, value, applied:false});continue; }
      const match = this.resolve(name);
      if (!match || match.index >= mesh.morphTargetInfluences.length) { unknown.push({name, value});continue; }
      mesh.morphTargetInfluences[match.index] = clamp ? Math.max(0, Math.min(1, value)) : value;
      this.previous.add(match.index);mapped.push({name, ...match, value});
    }
    return {mapped, unknown, control};
  }
  clear(mesh) {
    for (const index of this.previous) mesh.morphTargetInfluences[index] = 0;
    this.previous.clear();
  }
}
