import {b64url,canonical} from '../../shared/protocol.mjs';
export class Memory {
  items=new Map(); async get(k){return structuredClone(this.items.get(k));}
  async put(k,v){if(typeof k==='object')for(const [n,x]of Object.entries(k))this.items.set(n,structuredClone(x));else this.items.set(k,structuredClone(v));}
  async delete(k){this.items.delete(k);} async list({prefix}){return new Map([...this.items].filter(([k])=>k.startsWith(prefix)));}
}
export async function owner() {
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const {kty,crv,x,y}=await crypto.subtle.exportKey('jwk',keys.publicKey);
  return {public_key:{kty,crv,x,y},sign:async challenge=>({challenge,signature:b64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(canonical(challenge))))})};
}
export const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(callback,timeout=45000) {const start=Date.now();while(Date.now()-start<timeout){const value=await callback();if(value)return value;await wait(100);}throw new Error('Timed out waiting for browser flow.');}
