"""Allowlisted result export. Never include configs, credentials, PMX or game assets."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from report import summarize

def compact_record(data):
    for event in data.get('events', []):
        if event.get('type') == 'audio' and 'delta' in event:
            raw = base64.b64decode(event.pop('delta'))
            event['pcmBytes'] = len(raw); event['pcmSha256'] = hashlib.sha256(raw).hexdigest()
    return data

def create_bundle(output):
    output = Path(output)
    summary = summarize(output)
    manifest = json.loads((output / 'experiment.json').read_text(encoding='utf-8'))
    destination = output / 'Aemeath-early-action-results.zip'
    temporary = output / 'Aemeath-early-action-results.tmp.zip'
    videos = {'greet-r1-A', 'greet-r1-B', 'greet-r1-C', 'compare-r1-C', 'prep-cancel-C', 'speech-cancel-C'}
    with ZipFile(temporary, 'w', ZIP_DEFLATED, compresslevel=5) as archive:
        for name in ['summary.json', 'experiment.json', 'ledger.json', 'source-freeze.json', 'sync-validation.json']:
            path = output / name
            if path.is_file(): archive.write(path, name)
        for key in manifest['cases']:
            sync_suffixes = [f'-sync-{timing}{interrupt}-replay-client.json'
                             for timing in ('legacy', 'immediate') for interrupt in ('', '-interrupt')]
            for suffix in ['.json', '-client.json', '.wav'] + sync_suffixes + (['.webm'] if key in videos else []):
                path = output / (key + suffix)
                if not path.is_file(): continue
                if suffix == '.json':
                    data = compact_record(json.loads(path.read_text(encoding='utf-8')))
                    archive.writestr(path.name, json.dumps(data, ensure_ascii=False))
                else: archive.write(path, path.name)
        failures = []
        for path in (output / 'connection-failures').glob('*/*.json'):
            if path.name.endswith('-client.json'): continue
            data = json.loads(path.read_text(encoding='utf-8'))
            failures.append({k: data.get(k) for k in ['case', 'error', 'connectionError', 'metrics', 'machineBefore']})
        archive.writestr('connection-failures.json', json.dumps(failures, ensure_ascii=False))
        archive.writestr('README.txt', '实验性三组动作提前测试。\n'+summary['conclusion']+'\n\n'
            'summary.json 是统计；*-client.json 是浏览器播放、PMX姿态和打断记录；各样本.json 是服务端事件和用量。'
            'WAV 为真实生成音频，WEBM 为部分代表样本及打断探针录像。没有成功生成时文件可缺少。\n'
            '音频事件的原始base64在导出时改成字节数和SHA256，原始事件仍保留在本机。'
            '不含API Key、配置文件、角色模型、游戏资源或WAI真实记忆/历史。\n'
            '准备探针仅本地撤销并排空云端；出声探针发送provider cancel。首声为WebAudio时间证据，不是物理扬声器测量。\n')
    temporary.replace(destination)
    return destination

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('output', type=Path); args = parser.parse_args()
    print(create_bundle(args.output))
