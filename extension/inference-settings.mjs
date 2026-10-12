import {inferenceProfile,random} from './protocol.mjs';
import {purposeBrowserModel} from './purpose-browser-model.mjs';
export async function inferenceSettings(){return (await chrome.storage.local.get('inference_settings')).inference_settings || null;}
export function inferencePresentation(settings){return {profile:settings?inferenceProfile(settings.profile):null,has_key:false};}
export async function saveInference(input,register){
  if(input.provider==='local'){await register({inference:null});await chrome.storage.local.remove('inference_settings');await chrome.storage.local.set({inference_preference:'local'});return inferencePresentation(null);}
  const profile=inferenceProfile({id:random(),provider:input.provider,endpoint:input.endpoint,model:input.model,format:input.format});
  if(profile.provider!=='purpose_browser')throw new Error('Choose a local classifier. Remote inference is unavailable.');
  const settings={profile,api_key:''};await purposeBrowserModel(settings).warmup();await chrome.storage.local.set({inference_settings:settings});await register({inference:profile});return inferencePresentation(settings);
}
export async function testInference(){const settings=await inferenceSettings();if(!settings)throw new Error('Use Chrome built-in AI or install the local ONNX bundle.');const start=performance.now();await purposeBrowserModel(settings).warmup();return {milliseconds:performance.now()-start,decision:true};}
