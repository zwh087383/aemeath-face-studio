import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeExpression, NativeExpressionBinding, evaluateNativeCurve, readNativeExpression} from '../preview/core/native-expression.js';

const curve = (name, values) => ({name, keys:values.map(([time, value]) => ({time, value, interpolation:'RCIM_Linear'}))});

test('decoded native curve values are independent of the asset filename', () => {
  const data = {sourceAsset:'not-a-label/unknown.uasset', duration:1,
    curves:[curve('M_Smile_R', [[0,.75], [1,.75]]), curve('M_Smile_L', [[0,.6181814], [1,.6181814]])]};
  const clip = new NativeExpression(data);
  assert.equal(clip.sample(.4).M_Smile_R, .75);
  assert.equal(clip.sample(100).M_Smile_L, .6181814);
  assert.deepEqual(new NativeExpression({sourceAsset:'Aimisi_Happy.uasset', curves:[]}).sample(.2), {});
});

test('raw CUE4Parse AnimSequence float curves preserve source names and interpolation', () => {
  const raw = [{Type:'AnimSequence', Name:'a', Properties:{NumFrames:1, SequenceLength:0,
    AdditiveAnimType:'AAT_LocalSpaceBase'}, CompressedCurveNames:[{DisplayName:'B_Happy'}],
    CompressedCurveData:{FloatCurves:[{FloatCurve:{Keys:[{Time:0, Value:.4272728, InterpMode:'RCIM_Linear'}]}}]}}];
  const clip = new NativeExpression(raw);
  assert.deepEqual(clip.sample(10), {B_Happy:.4272728});
  assert.deepEqual(clip.data.additiveTypes, ['AAT_LocalSpaceBase']);
});

test('right and left native mouth and eyelid channels select half-face morphs', () => {
  const dictionary = {'口角上げ':0, '右口角上げ':1, '左口角上げ':2, '笑い':3, 'ウィンク右':4, 'ウィンク':5};
  const mesh = {morphTargetDictionary:dictionary, morphTargetInfluences:new Float32Array(6)};
  const binding = new NativeExpressionBinding(mesh);
  const result = binding.apply(mesh, {M_Smile_R:.75, M_Smile_L:.5, E_Smile_R:1});
  assert.deepEqual(Array.from(mesh.morphTargetInfluences), [0,.75,.5,0,1,0]);
  assert.equal(result.mapped.length, 3);
  assert.deepEqual(result.unknown, []);
  binding.apply(mesh, {E_Smile_L:.5});
  assert.deepEqual(Array.from(mesh.morphTargetInfluences), [0,0,0,0,0,.5]);
});

test('unknown morphs and SeqMouthAlpha remain visible and never alter a guessed target', () => {
  const mesh = {morphTargetDictionary:{'あ4':0}, morphTargetInfluences:[.2]};
  const binding = new NativeExpressionBinding(mesh);
  const result = binding.apply(mesh, {A:.6, SeqMouthAlpha:0, unknown_sad_face:1});
  assert.equal(mesh.morphTargetInfluences[0], .6);
  assert.deepEqual(result.control, [{name:'SeqMouthAlpha', value:0, applied:false}]);
  assert.deepEqual(result.unknown, [{name:'unknown_sad_face', value:1}]);
});

test('interpolation, looping and out-of-range additive values are deterministic', () => {
  const clip = new NativeExpression({duration:1, curves:[curve('A', [[0,-.2],[1,1.2]])]});
  assert.equal(clip.sample(0).A, -.2);
  assert.ok(Math.abs(clip.sample(.5).A - .5) < 1e-10);
  assert.equal(clip.sample(1.5).A, 1.2);
  assert.ok(Math.abs(clip.sample(1.5, {loop:true}).A - .5) < 1e-10);
  assert.deepEqual(clip.sample(.3), clip.sample(.3));
});

test('constant and Hermite curves retain non-linear transition shapes', () => {
  const clip = new NativeExpression({curves:[{name:'A', keys:[
    {time:0, value:0, interpolation:'RCIM_Constant'},
    {time:1, value:1, interpolation:'RCIM_Cubic', leaveTangent:0},
    {time:2, value:0, arriveTangent:0},
  ]}]});
  assert.equal(clip.sample(.9).A, 0);
  assert.equal(clip.sample(1).A, 1);
  assert.ok(Math.abs(clip.sample(1.25).A - .84375) < 1e-10);
});

test('weighted Bezier time tangents remain finite and smooth', () => {
  const data = readNativeExpression({curves:[{name:'A', keys:[
    {time:0, value:0, interpolation:'RCIM_Cubic', tangentWeightMode:'RCTWM_WeightedLeave', leaveTangent:1, leaveTangentWeight:.2},
    {time:1, value:1, tangentWeightMode:'RCTWM_WeightedArrive', arriveTangent:1, arriveTangentWeight:.2},
  ]}]});
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const value = evaluateNativeCurve(data.curves[0], i / 100);
    assert.ok(Number.isFinite(value) && value >= previous);
    assert.ok(Math.abs(value - i / 100) < 1e-8);
    previous = value;
  }
});

test('bad parameters fail visibly; unnamed curves are reported', () => {
  assert.throws(() => new NativeExpression({curves:[curve('A', [[0,NaN]])]}), /invalid key/);
  const data = readNativeExpression({curves:[curve(null, [[0,1]])]});
  assert.equal(data.curves.length, 0);
  assert.ok(data.warnings.length > 0);
});
