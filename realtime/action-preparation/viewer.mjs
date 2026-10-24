const $ = id => document.getElementById(id);
const names = { 'native-body': '原生身体', 'native-ribbon': '原生衣发', 'native-look': '原生注视', 'native-prop-animation': '道具动画',
  'expression': '表情（原生与原创）', 'default-face': '默认脸资料', 'gesture': '已有原创手势', 'activity': '已有全身活动',
  'micro': '头部与眨眼反应', 'sequence': '连续活动配方', 'authored-gesture': '已有原创手势', 'authored-activity': '已有连续活动' };
const stateNames = { measured_review_pending: '已测量 · 待实模审阅', blocked: '资料或出口有缺口', excluded: '不纳入自动动作', pending: '待整理',
  'offline-measured-awaiting-model-review': '表情已分析 · 待实模审阅',
  'recipe-and-child-evidence-prepared-awaiting-continuous-acceptance': '配方已整理 · 待连续验收',
  'single-controller-sampled-awaiting-composition-review': '单控制器已采样 · 待共同合成',
  'source-and-cpu-sampled-awaiting-scene-and-visual-review': '活动已采样 · 待场景与观感验收',
  'source-and-cpu-sampled-awaiting-visual-and-integration': '手势已采样 · 待观感与接入验收',
  'target-and-speech-ownership-sampled-awaiting-morph-and-timing-review': '表情口型隔离已测 · 待实模与时序验收' };
const blockerNames = {
  'real-model-continuous-review-required': '需要在真实模型上连续检查出现、退出和切换。',
  'shared-morph-owner-integration-required': '表情、口型、眨眼与注视尚需统一合成，避免相互覆盖。',
  'entry-exit-cancel-envelope-required': '还需制作从当前表情进入、退出与中途取消的连续过程。',
  'original-recipe-overlaps-speech-mouth': '原配方会影响发音嘴形，不能直接整张脸叠到语音上。',
  'not-aemeath-specific-review-required': '这份资料不是爱弥斯专属，需单独检查适配。',
  'unmapped-source-controls': '部分源控制在当前模型没有映射，效果不完整。',
};
const label = kind => names[kind] ?? kind;
const stateLabel = status => stateNames[status] ?? status;
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const printable = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const describe = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(describe).join('；');
  if (!value || typeof value !== 'object') return String(value ?? '待确认');
  const labels = { judge: '由谁决定', basis: '依据', unknown: '不确定时', caveat: '限制', note: '说明', fact: '事实', detail: '细节' };
  const rows = Object.entries(value).filter(([key]) => labels[key]).map(([key, item]) => `${labels[key]}：${describe(item)}`);
  return rows.length ? rows.join('；') : printable(value);
};
let catalog, filtered = [], selected = null, page = 0, previewRequest = 0;
const pageSize = 25;

function stats() {
  const byKind = catalog.summary.byKind;
  const facts = [
    [byKind['native-body'] ?? 0, '原生身体片段'], [catalog.families?.length ?? 0, '按源目录区分的动作组'],
    [Object.entries(byKind).filter(([k]) => k.includes('gesture') || k.includes('activity')).reduce((sum, [, n]) => sum + n, 0), '原创手势与活动记录'],
    [catalog.summary.records, '全部准备记录'], [0, '本批新增自动使用许可'],
  ];
  $('summary').replaceChildren(...facts.map(([value, caption]) => { const el = node('div', undefined, 'stat'); el.append(node('b', String(value)), node('span', caption)); return el; }));
}

function filter(reset = true) {
  const search = $('search').value.trim().toLowerCase(), kind = $('kind').value, status = $('status-filter').value;
  filtered = catalog.items.filter(row => (!kind || row.kind === kind) && (!status || row.preparationStatus === status)
    && (!search || [row.name, row.id, row.sourceRef, row.usage, row.blockers].map(printable).join(' ').toLowerCase().includes(search)));
  if (reset) page = 0;
  page = Math.max(0, Math.min(page, Math.ceil(filtered.length / pageSize) - 1));
  $('list-status').textContent = `${filtered.length} 条 · 同一动作的不同阶段和资源类型分别登记`;
  $('records').replaceChildren(...filtered.slice(page * pageSize, (page + 1) * pageSize).map(row => {
    const button = node('button', undefined, 'record'); button.type = 'button'; button.setAttribute('aria-pressed', String(selected?.id === row.id));
    const origin = row.sourceCatalog === 'authored' ? '原创' : '原生';
    button.append(node('b', row.name), node('small', `${origin} / ${label(row.kind)} / ${stateLabel(row.preparationStatus)}`));
    button.onclick = () => select(row.id); return button;
  }));
  $('page').textContent = `${filtered.length ? page + 1 : 0} / ${Math.ceil(filtered.length / pageSize)}`;
  $('prev').disabled = page <= 0; $('next').disabled = (page + 1) * pageSize >= filtered.length;
}

function fieldList(fields) {
  const dl = node('dl', undefined, 'fields');
  for (const [key, value] of fields) dl.append(node('dt', key), node('dd', describe(value)));
  return dl;
}

function select(id) {
  selected = catalog.items.find(row => row.id === id); if (!selected) return;
  const row = selected, article = $('detail'), usage = row.usage;
  const origin = row.sourceCatalog === 'authored' ? '现有原创控制器' : '原生资源';
  article.replaceChildren(node('p', `${origin} / ${label(row.kind)} / ${row.category ?? '当前资源'}`, 'eyebrow'), node('h2', row.name));
  article.append(node('span', stateLabel(row.preparationStatus), 'badge'), node('span', '自动调用关闭', 'badge'));
  article.append(node('h3', '想表达什么，为什么考虑它'), node('p', printable(usage.purpose)),
    fieldList([['触发依据', usage.trigger], ['开始前', usage.preconditions], ['不适合', usage.prohibited], ['怎样进入', usage.entry], ['怎样退出', usage.exit], ['中途取消', usage.cancel]]));
  if (usage.semanticEvidence) article.append(node('p', printable(usage.semanticEvidence), 'source'));
  article.append(node('h3', '还缺什么'), ...row.blockers.map(text => node('p', blockerNames[text] ?? printable(text), 'issue')));
  const m = row.measurements;
  article.append(node('h3', '实际测到的资料'), fieldList([
    ['时长', row.durationSeconds === undefined ? '见下方原始测量' : `${Number(row.durationSeconds).toFixed(3)} 秒`],
    ['源帧数', m.sourceFrames ?? m.frameCount ?? '见下方原始测量'],
    ['位移', m.rootTravelCm === undefined ? '见下方原始测量' : `源Root累计 ${m.rootTravelCm.toFixed(3)} cm`],
    ['记录依据', row.evidence.map(describe).join('\n')],
  ]));
  if (row.clothCandidates?.length) article.append(node('p', `衣发候选 ${row.clothCandidates.length} 项；按名称寻找，仍需核对骨架、时长、阶段和实际蒙皮。`));
  const seams = (catalog.seams ?? []).filter(s => s.from === id || s.to === id);
  if (seams.length) {
    article.append(node('h3', '相邻阶段的衔接测量'), node('p', '这里只比较源轨迹端点和速度；小差异不等于已经可任意打断。'));
    const table = node('table', undefined, 'seams'), head = node('tr');
    ['到哪个阶段', '最大姿态差', '最大角速度差'].forEach(x => head.append(node('th', x))); table.append(head);
    for (const seam of seams.slice(0, 12)) {
      const tr = node('tr'), other = catalog.items.find(x => x.id === (seam.from === id ? seam.to : seam.from));
      for (const value of [other?.name ?? '未知', Number.isFinite(seam.rotationGapDeg) ? `${seam.rotationGapDeg.toFixed(3)}°` : '未测', Number.isFinite(seam.angularVelocityGapDegPerSec) ? `${seam.angularVelocityGapDegPerSec.toFixed(3)}°/秒` : '未测']) tr.append(node('td', value));
      table.append(tr);
    }
    article.append(table);
  }
  if (!row.blocked && row.preparationStatus !== 'blocked') {
    const button = node('button', '在当前模型上预览这项资源'); button.type = 'button'; button.onclick = () => preview(id); article.append(button);
  }
  const detail = node('details'), summary = node('summary', '查证用完整记录'); detail.append(summary, node('pre', JSON.stringify(row, null, 2))); article.append(detail);
  filter(false);
}

async function preview(id) {
  const row = catalog.items.find(item => item.id === id); if (!row) return;
  const request = ++previewRequest, frame = $('preview'); $('preview-section').hidden = false;
  const authored = row.sourceCatalog === 'authored';
  const activity = authored && ['activity', 'sequence'].includes(row.kind);
  const route = !authored ? '/native-resources/' : activity ? '/activities/' : '/performance/';
  frame.title = authored ? '已有原创动作模型预览' : '原生动作模型预览';
  $('preview-status').textContent = '首次读取模型可能较慢；这是素材预览，不是过渡验收。';
  if (frame.getAttribute('src') !== route) frame.src = route;
  const started = performance.now();
  while (request === previewRequest && performance.now() - started < 180000) {
    const api = frame.contentWindow?.[!authored ? 'nativeResources' : activity ? 'activityLab' : 'performanceLab'];
    if (api?.snapshot().ready && frame.contentWindow.location.pathname === route) {
      try {
        if (authored) {
          const runtime = row.runtimeId;
          let accepted;
          if (activity) accepted = api.choose(row.kind === 'sequence' ? 'sequences' : 'activities', runtime);
          else if (row.kind === 'gesture') accepted = api.play(runtime);
          else if (row.kind === 'expression') accepted = api.director.playExpression(runtime, 1);
          else if (row.kind === 'micro') accepted = api.director.playAction(runtime, { intensity: 1 });
          if (!accepted) throw Error('当前控制器没有接纳这项预览；没有将背景动作当作成功。');
          const actual = api.snapshot();
          if (actual.error) throw Error(actual.error);
          const actualId = activity ? actual.selected?.id : row.kind === 'gesture' ? actual.director.selected
            : actual.director.events.at(-1)?.[row.kind === 'expression' ? 'preset' : 'action'];
          if (actualId !== runtime) throw Error('实际控制器选中项与本条记录不一致。');
          $('preview-status').textContent = activity
            ? '本条已交给原有全身活动播放器；可暂停、停止、换视角。道具持续性和阶段过渡仍按缺口记录审阅。'
            : '本条已交给原有身体与表情播放器；可暂停、打断、换视角。本页不代表与原生衣发或真实语音合成通过。';
          return;
        }
        const result = await api.select(id);
        if (request !== previewRequest) return;
        if (result.error) throw Error(result.error);
        if (result.selectedId !== id) throw Error('当前实际选中项与请求不同，请在原生页检查。');
        if (result.resourceKind === 'body') {
          if (result.currentId !== id) throw Error('身体尚未切到本条动作，不能将旧动作当作本条预览。');
          $('preview-status').textContent = '本条身体已加载；原骨架与当前模型共用时间轴，可暂停、拖动、换视角。';
        } else if (['expression', 'default-face'].includes(result.resourceKind)) {
          const mapped = result.inspection?.morphs?.mapped?.length ?? 0;
          const active = result.faceLayers?.some(layer => layer.id === id);
          $('preview-status').textContent = mapped && active
            ? `本条表情已映射到右侧PMX的 ${mapped} 个通道；左侧灰模没有面部形变，背景身体不属于本条表情。`
            : '本条仅资料查看：当前模型没有可播放的映射；背景身体动作不是本条表情效果。';
        } else if (result.resourceKind === 'prop-animation') {
          if (!result.prop) throw Error('道具模型尚未加载。');
          $('preview-status').textContent = '独立道具动画已加载；这不代表已经挂接到人物或验证拿放。';
        } else {
          if (!result.layers?.some(layer => layer.id === id)) throw Error('目标局部层尚未实际加载。');
          $('preview-status').textContent = '本条局部层已加载；两侧映射可能不同，请结合原生页说明检查实际效果。';
        }
      } catch (error) { if (request === previewRequest) $('preview-status').textContent = `资源尚不能预览：${error.message}`; }
      return;
    }
    if (frame.contentWindow?.nativeResourcesError) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (request === previewRequest) $('preview-status').textContent = '预览准备未完成，请检查播放器加载说明；资料册仍可继续查看。';
}

try {
  const response = await fetch('/action-preparation-data/catalog.json'); if (!response.ok) throw Error(`准备目录未生成（HTTP ${response.status}）`);
  catalog = await response.json(); if (catalog.schema !== 'aemeath-preparation/v1' || !Array.isArray(catalog.items)) throw Error('不支持的资料格式');
  for (const kind of Object.keys(catalog.summary.byKind).sort()) { const option = node('option', `${label(kind)} · ${catalog.summary.byKind[kind]}`); option.value = kind; $('kind').append(option); }
  for (const status of Object.keys(catalog.summary.byStatus).sort()) { const option = node('option', stateLabel(status)); option.value = status; $('status-filter').append(option); }
  $('search').oninput = () => filter(); $('kind').onchange = () => filter(); $('status-filter').onchange = () => filter();
  $('prev').onclick = () => { page--; filter(false); }; $('next').onclick = () => { page++; filter(false); };
  stats(); filter(); if (catalog.items.length) select(catalog.items.find(r => r.kind === 'native-body' && r.name.includes('思考'))?.id ?? catalog.items[0].id);
  window.actionPreparation = { snapshot: () => ({ ready: true, selectedId: selected?.id, visible: filtered.length, page, records: catalog.items.length }), select, preview };
} catch (error) { $('summary').textContent = error.message; window.actionPreparationError = error.message; }
