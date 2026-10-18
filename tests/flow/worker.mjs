// Test-only entrypoint. Production wrangler.jsonc never imports this module.
// Emulates cloud acquisition only; all requests and signed approvals use Gate.
import production, {Gate as ProductionGate, Registry} from '../../src/worker.mjs';
export {Registry};
export class Gate extends ProductionGate {
  constructor(ctx, env) {super(ctx, {...env, BROWSER:{}, HOSTED_MODELS:{}});this.hostedConsent.available=true;this.hostedConsent.model ||= 'agentgate-purpose-browser-'+'f'.repeat(16);}
  kickHosted() {} // The harness drives the real HostedBrowser with local Chromium.
  async demo(path, data) {
    if(path==='alarm-status')return {next_alarm:await this.ctx.storage.getAlarm()};
    if(path==='expire-session')return this.hostedLock(async()=>{
      const item=await this.engine.get(data.id);item.expires_at=Date.now()+1000;await this.engine.save(item);return {expires_at:item.expires_at};
    });
    if(path==='snapshot')return this.hostedSnapshot();
    if(path==='config')return this.hostedConsent.current();
    if(path==='classifier-ready')return this.classifier.allowed(data.browser_id);
    return this.hostedCall(path,data);
  }
}
export default {async fetch(request,env,ctx) {
  const url=new URL(request.url);
  if(!['127.0.0.1','localhost'].includes(url.hostname))return new Response('Local tests only',{status:403});
  if(url.pathname==='/_demo/hosted') {
    if(!env.DEMO_TOKEN || request.headers.get('Authorization')!=='Bearer '+env.DEMO_TOKEN)return new Response('Unauthorized',{status:403});
    try {const {path,data}=await request.json();return Response.json(await env.GATE.getByName('single-owner-v1').demo(path,data));}
    catch(error){return Response.json({error:{code:error.code||'DEMO_ERROR',message:error.message}},{status:409});}
  }
  return production.fetch(request,env,ctx);
}};
