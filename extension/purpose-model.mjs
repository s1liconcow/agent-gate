import {exact,inferenceProfile} from './protocol.mjs';
import {abortable} from './deadline.mjs';
import {boundedJson,inferenceError,remoteCodes} from './remote-model.mjs';

export function purposeModel(settings,{fetcher=globalThis.fetch,authorize=async()=>{}}={}) {
  const profile=inferenceProfile(settings.profile),token=settings.api_key;
  if(profile.provider!=='purpose_encoder'||typeof token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw inferenceError('INFERENCE_AUTH_FAILED');
  return {async classify(row,signal) {
    if(!signal)throw inferenceError('INFERENCE_NOT_APPROVED');
    await abortable(authorize,signal);signal.throwIfAborted();
    try {
      const response=await abortable(()=>fetcher(profile.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({model:profile.model,goal:row.goal,need:row.need,context:row.context,text:row.text}),
        credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal}),signal);
      if(!response.ok){response.body?.cancel().catch(()=>{});throw inferenceError([401,403].includes(response.status)?'INFERENCE_AUTH_FAILED':'INFERENCE_UNAVAILABLE');}
      const result=await boundedJson(response,signal);exact(result,['model','probability']);
      if(result.model!==profile.model||typeof result.probability!=='number'||!Number.isFinite(result.probability)||result.probability<0||result.probability>1)throw inferenceError();
      return result.probability;
    }catch(error){if(signal.aborted)throw signal.reason;if(remoteCodes.includes(error.code))throw error;throw inferenceError();}
  }};
}
