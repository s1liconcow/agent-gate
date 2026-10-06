import {ElementChecker,eligibleElements} from './element-check.mjs';
import {prepareSnapshot} from './disclosure.mjs';
window.benchmark={state:'ready',samples:[]};
const options={expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]};
window.benchmark.availability=globalThis.LanguageModel?await LanguageModel.availability(options):'unavailable';
document.getElementById('start').onclick=async()=>{
  const {cases,runs}=await(await fetch('./input.json')).json(),checker=new ElementChecker();
  window.benchmark.state='running';
  try {
    const start=performance.now();await checker.enable();window.benchmark.startup_ms=performance.now()-start;
    window.benchmark.sampling=checker.sessions.map(s=>({topK:s.topK,temperature:s.temperature}));
    if(typeof LanguageModel.params==='function'&&checker.sessions.some(s=>s.topK!==1||s.temperature!==0))throw new Error('Predictable native sampling was not applied.');
    for(let run=0;run<=runs;run++) for(const c of cases) {
      const task={goal:c.goal,origins:['https://mail.example'],permissions:['read']},request={need:c.need};
      const blocks=c.entries.map((e,i)=>({...e,ref:(i+1).toString(16).padStart(32,'0')}));
      const expected=c.expected.map(i=>blocks[i].ref),sample={case:c.id,run,expected,released:[]},started=performance.now();
      window.benchmark.current={case:c.id,run};
      try {
        const entries=prepareSnapshot({origin:task.origins[0],blocks,controls:[]},task).entries;
        sample.elements=[];
        for(const entry of entries) {
          const elementStart=performance.now();
          const result=await checker.evaluate(task,request,[entry],{milliseconds:10000});
          sample.elements.push({id:entry.id,milliseconds:performance.now()-elementStart,model_evaluated:eligibleElements(task,[entry]).length===1});
          sample.released.push(...result.ids);
        }
      }catch(error){sample.error=error.code||'LOCAL_CHECK_FAILED';}
      sample.milliseconds=performance.now()-started;
      sample.false_releases=sample.released.filter(id=>!expected.includes(id));sample.missed_releases=expected.filter(id=>!sample.released.includes(id));sample.correct=!sample.error&&!sample.false_releases.length&&!sample.missed_releases.length;
      window.benchmark.samples.push(sample);
    }
    window.benchmark.state='complete';
  }catch(error){window.benchmark.state='failed';window.benchmark.error=error.code||'MODEL_UNAVAILABLE';}
  finally{checker.destroy();}
};
