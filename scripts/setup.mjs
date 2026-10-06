import {mkdir, readFile, writeFile, chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {randomBytes, createECDH} from 'node:crypto';
import QRCode from 'qrcode';
const configDir = process.env.AGENTGATE_CONFIG_DIR || resolve(homedir(), '.agentgate-control');
await mkdir(configDir, {recursive: true, mode: 0o700});
const configPath = resolve(configDir, 'config.json');
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const vapid = createECDH('prime256v1'); vapid.generateKeys();
  config = {url: 'http://127.0.0.1:8788', agent_token: randomBytes(32).toString('base64url'), bridge_token: randomBytes(32).toString('base64url'), pairing_token: randomBytes(32).toString('base64url'), vapid_public_key: vapid.getPublicKey().toString('base64url'), vapid_private_key: vapid.getPrivateKey().toString('base64url')};
  await writeFile(configPath, JSON.stringify(config, null, 2), {mode: 0o600});
}
const vars = `AGENT_TOKEN=${config.agent_token}\nBRIDGE_TOKEN=${config.bridge_token}\nPAIRING_TOKEN=${config.pairing_token}\nVAPID_PUBLIC_KEY=${config.vapid_public_key}\nVAPID_PRIVATE_KEY=${config.vapid_private_key}\nVAPID_SUBJECT=https://example.invalid/agentgate\n`;
await writeFile(new URL('../.dev.vars', import.meta.url), vars, {mode: 0o600});
await chmod(new URL('../.dev.vars', import.meta.url), 0o600);
await writeFile(resolve(configDir, 'phone-pairing-url.txt'), `${config.url}/#pair=${config.pairing_token}\n`, {mode: 0o600});
await writeFile(resolve(configDir, 'browser-settings.json'), JSON.stringify({url: config.url, extension_download: config.url + '/agentgate-extension.zip'}, null, 2), {mode: 0o600});
const pairingUrl = `${config.url}/#pair=${config.pairing_token}`;
const qr = await QRCode.toDataURL(pairingUrl, {width: 240, margin: 2, errorCorrectionLevel: 'M'});
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const ownerPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentGate · private desktop setup</title><style>body{font:15px/1.6 system-ui,sans-serif;background:#0d1117;color:#edf3f8;max-width:640px;margin:40px auto;padding:24px}h1{font-size:30px;line-height:1.2;letter-spacing:-.025em}h2{font-size:19px;margin:30px 0 12px}p,label{color:#a4b4c9}a{color:#8de4bd;text-underline-offset:4px}img{border-radius:12px}label{display:block;font-size:13px;margin:16px 0}input{display:block;box-sizing:border-box;width:100%;margin-top:7px;border:1px solid #3c4b60;border-radius:8px;background:#141b25;color:#edf3f8;padding:12px;font:14px system-ui}input:focus{outline:2px solid #8de4bd;outline-offset:3px}summary{cursor:pointer}li{margin:10px 0}footer{margin-top:32px;border-top:1px solid #2a3545;padding-top:20px;font-size:12px;color:#a4b4c9}</style><main><h1>Pair your phone.</h1><p>Scan this code with your Android phone, then choose “Pair this phone” in AgentGate. This code pairs one approval device.</p><img src="${qr}" width="240" height="240" alt="Private one-time phone pairing QR code"><p><a href="${escape(pairingUrl)}">Open phone pairing link</a></p><h2>Connect your browser</h2><ol><li><a href="${escape(config.url)}/agentgate-extension.zip">Download the Chrome extension</a>, unzip it, then load that folder in <strong>chrome://extensions → Developer mode → Load unpacked</strong>. You can also load <strong>extension/</strong> directly.</li><li>Open a website and click AgentGate’s toolbar icon. Choose <strong>Pair with phone</strong> under Connect browser.</li><li>Scan the extension’s QR on your already paired phone and approve the browser connection. The extension saves its credential and verifies the phone key automatically.</li></ol><p>No local broker or copied device keys are needed. A new browser connection replaces the previous browser. Your phone can revoke it.</p><h2>Connect ChatGPT or Claude</h2><label>Remote MCP endpoint<input readonly value="${escape(config.url)}/mcp"></label><p>Add this endpoint as a custom MCP app or connector using OAuth and automatic client registration. Approve the assistant connection on your paired phone. Each browser task still requires its own scoped approval.</p><h2>Enable local disclosure planning</h2><p>In the extension, choose Allow approved tasks on websites and Enable local agent once. Close the setup page when ready. Phone approval automatically opens future tasks in their own tabs; a local agent checks disclosures and actions against the signed purpose. If Chrome cannot run the model, manual review is an explicit fallback.</p><footer>Private owner setup. The assistant gets a separate agent credential. Pairing information is saved outside the project and is never part of the hosted app.</footer></main></html>`;
await writeFile(resolve(configDir, 'owner-setup.html'), ownerPage, {mode: 0o600});
console.log(`Owner configuration saved to ${configDir}.\nPhone pairing URL: phone-pairing-url.txt\nBrowser download settings: browser-settings.json\nCredentials were not printed. Existing configuration was preserved.`);
