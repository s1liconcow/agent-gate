"""Create local secrets. Run only as the device owner, never inside an agent sandbox."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--extension-id', required=True)
    p.add_argument('--directory', default=str(Path.home()/'.agentgate'))
    p.add_argument('--reviewer', choices=['ollama', 'manual'], default='ollama')
    p.add_argument('--model', default='qwen3:8b')
    a = p.parse_args()
    if not re.fullmatch(r'[a-p]{32}', a.extension_id):
        p.error('Copy the 32-character ID from chrome://extensions.')
    root = Path(a.directory).expanduser()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    config = {'extension_id': a.extension_id, 'device_token': secrets.token_urlsafe(48),
              'agent_token': secrets.token_urlsafe(48), 'reviewer': a.reviewer, 'model': a.model}
    dest = root/'config.json'
    if dest.exists():
        p.error('Configuration already exists. Move it aside to rotate both keys.')
    fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(config, f, indent=2)
    print('Configuration: ' + str(dest))
    print('\nDEVICE KEY - paste only into the extension pairing field:\n' + config['device_token'])
    print('\nAGENT KEY - give only this key to the MCP client:\n' + config['agent_token'])
    print('\nKeep the configuration directory outside the agent workspace. Windows users should restrict its ACL.')

if __name__ == '__main__': main()
