"""Summarize immutable live records; replay/offline fixtures never enter totals."""
import argparse
import json
from pathlib import Path
import statistics

def summarize(output):
    experiment = json.loads((output / 'experiment.json').read_text(encoding='utf-8'))
    rows = []
    for key, case in experiment['cases'].items():
        path = output / f'{key}.json'
        if not path.exists(): continue
        data = json.loads(path.read_text(encoding='utf-8'))
        client_path = output / f'{key}-client.json'
        client = json.loads(client_path.read_text(encoding='utf-8')) if client_path.exists() else {}
        if client and client.get('mode') != 'live': raise ValueError('non_live_measurement_in_live_slot')
        outcome = '已完成' if data['completed'] else '已取消' if data['cancelled'] else '无完整语音'
        if case['probe'] and not client.get('interrupt'): outcome += '；打断时机未出现'
        if client.get('failure'): outcome = '客户端失败：' + client['failure']
        if data['metrics']['responseCreates'] == 0: outcome = '连接失败，未发模型请求：' + data.get('error', 'unknown')
        rows.append({'id': key, 'group': case['group'], 'scene': case['scene'], 'probe': case['probe'],
            'server': data['metrics'], 'client': client.get('latency'), 'performance': client.get('performance'),
            'completed': data['completed'], 'scriptMatch': data['scriptMatch'],
            'tool': [e['plan'] for e in data['events'] if e['type'] == 'tool'],
            'usageStatus': (data.get('response') or {}).get('usageStatus'), 'outcome': outcome,
            'connectionError': data.get('connectionError'),
            'interrupt': client.get('interrupt'), 'sourceCountAfter': client.get('finalAudio', {}).get('sourceCount'),
            'contextToRequestMs': next((e['atMs'] for e in data['events'] if e['type'] == 'request_sent'), None)})
    def stats(values):
        values = [v for v in values if isinstance(v, (float, int))]
        return {'n': len(values), 'median': statistics.median(values), 'min': min(values), 'max': max(values)} if values else {'n': 0}
    groups = {}
    for group in experiment['groups']:
        selected = [r for r in rows if r['group'] == group and not r['probe'] and r['server']['responseCreates']]
        groups[group] = {'n': len(selected), 'complete': sum(r['completed'] for r in selected),
            'sameResponseBeforeReceipt': sum(r['server']['sameResponseBothBeforeReceipt'] for r in selected),
            'toolFirst': sum(r['server']['toolFirst'] for r in selected),
            'scriptMatch': sum(r['scriptMatch'] for r in selected),
            'toolOnly': sum(r['server']['toolOnly'] for r in selected),
            'firstPcmMs': stats(r['server']['firstNonSilentPcmMs'] for r in selected),
            'voiceMs': stats((r['client'] or {}).get('voiceMs') for r in selected),
            'clickToVoiceMs': stats((r['client'] or {}).get('clickToVoiceMs') for r in selected),
            'bodyLeadMs': stats((r['client'] or {}).get('bodyLeadMs') for r in selected),
            'faceLeadMs': stats((r['client'] or {}).get('faceLeadMs') for r in selected)}
    ledger = json.loads((output / 'ledger.json').read_text(encoding='utf-8'))
    usage = {'responses': len(ledger['responses']), 'limit': ledger['limit'], 'blocked': ledger['blocked'],
        'reported': sum(r['usageStatus'] == 'reported' for r in ledger['responses']),
        'unknown': sum(r['usageStatus'] == 'unknown' for r in ledger['responses']),
        'reportedTotalTokens': sum((r.get('usage') or {}).get('total_tokens', 0) for r in ledger['responses'] if r['usageStatus'] == 'reported')}
    c = groups['C']
    conclusion = (f"当前 {usage['responses']}/{usage['limit']} 个响应；动作优先组 {c['sameResponseBeforeReceipt']}/{c['n']} 个样本在同一响应内、回执前产生语音和动作，"
        f"其中 {c['toolFirst']} 个命令早于首有声包。提前量为正表示画面先动，为负表示声音先到。每组最多4个主样本，仅为小样本实验。")
    if usage['unknown']: conclusion += ' 存在未知用量，后续云调用已锁止。'
    summary = {'experimental': True, 'rows': rows, 'groups': groups, 'usage': usage, 'conclusion': conclusion,
        'boundaries': ['Fixed scripted context, not full microphone/retrieval latency.',
            'First voice: browser non-silent media cursor, not physical speaker acoustics.',
            'No receipt before response.done and no second response.create.',
            'Preparation cancellation probe drains provider without stopping cloud generation; speech probe requests provider cancel.',
            'Offline fixture and replay timings excluded. Small samples do not establish production reliability.']}
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    return summary

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('output', type=Path); args = parser.parse_args()
    summary = summarize(args.output)
    print(json.dumps({k: summary[k] for k in ['groups', 'usage', 'conclusion']}, ensure_ascii=False, indent=2))
