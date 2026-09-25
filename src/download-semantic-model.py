#!/usr/bin/env python3
"""Download only public model/tokenizer assets and pin their revision and hashes."""
import hashlib
import json
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

ROOT = Path(__file__).resolve().parents[1]


def main():
    config = json.loads((ROOT / 'config/workflow.json').read_text())['semantic_mapping']
    model_id = config['model_id']
    destination = ROOT / 'data/models/sapbert'
    manifest_path = destination / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['model_id'] == model_id:
            for asset in manifest['files']:
                path = destination / asset['name']
                with path.open('rb') as stream:
                    checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
                if checksum != asset['sha256']:
                    raise RuntimeError(f"Model asset checksum mismatch: {path}")
            print(f"Verified cached model revision {manifest['revision']}", flush=True)
            return
    info = HfApi().model_info(model_id)
    names = {asset.rfilename for asset in info.siblings}
    weights = 'model.safetensors' if 'model.safetensors' in names else 'pytorch_model.bin'
    requested = ['config.json', 'vocab.txt', 'tokenizer.json', 'tokenizer_config.json',
                 'special_tokens_map.json', 'README.md', weights]
    assets = []
    for name in requested:
        if name not in names:
            continue
        print(f"Downloading {name} at {info.sha}", flush=True)
        path = Path(hf_hub_download(model_id, name, revision=info.sha,
                                   local_dir=destination))
        with path.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        assets.append({'name': name, 'bytes': path.stat().st_size, 'sha256': checksum})
    destination.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps({
        'model_id': model_id, 'revision': info.sha, 'files': assets,
        'source': f'https://huggingface.co/{model_id}/tree/{info.sha}',
        'code_execution': 'trust_remote_code=False',
        'model_license': 'MIT according to publisher repository'
    }, indent=2) + '\n')
    print(f"Pinned model {model_id} {info.sha}", flush=True)


if __name__ == '__main__':
    main()
