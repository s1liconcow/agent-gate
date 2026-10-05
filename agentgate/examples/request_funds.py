"""Set AGENT_GATE_TOKEN first. This example checks a synthetic $250 amount only."""
from broker.client import Client
import json
client = Client()
print(json.dumps(client.request(kind='funds_check', origin='http://127.0.0.1:8080',
    purpose='Check whether the selected account has sufficient available balance for a $250 transfer.',
    parameters={'amount_cents': 25000, 'currency': 'USD'}), indent=2))
