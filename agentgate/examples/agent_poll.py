"""Usage: python -m examples.agent_poll REQUEST_ID [--revoke]. Set AGENT_GATE_TOKEN."""
import argparse
import json
from broker.client import Client
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('request_id');p.add_argument('--revoke',action='store_true');a=p.parse_args()
client=Client()
print(json.dumps(client.revoke(a.request_id) if a.revoke else client.result(a.request_id),indent=2))
