import test from 'node:test';import assert from 'node:assert/strict';
import {enforceSender,senderConstraint,sourceContext} from '../extension/purpose-constraints.mjs';
test('high-level author conditions require a separate observed header, never a body claim',()=>{
 const task={goal:'Read Jasper’s inbox messages about birdwatching.'},request={need:'Read birdwatching subjects.'};
 assert.equal(senderConstraint(task.goal).sender,'jasper');
 assert.equal(enforceSender(task,request,null),null);
 assert.equal(enforceSender(task,request,{label:'Opal',address:'opal@example.test'}),null);
 const compiled=enforceSender(task,request,{label:'Jasper',address:'jasper@example.test'});
 assert.equal(compiled.goal,'Read inbox messages about birdwatching.');
 assert.equal(enforceSender(task,{need:'Read messages from Opal about birdwatching.'},{label:'Jasper'}),null);
 assert.equal(senderConstraint('Read messages from iris@example.test about choir practice.').sender,'iris@example.test');
 assert.equal(senderConstraint('When can I collect my cat from the boarding service?').sender,null);
 assert.equal(senderConstraint('When does my child’s lesson start?').sender,null);
 const emailTask={goal:'Read messages from iris@example.test about choir practice.'};
 assert.equal(enforceSender(emailTask,{need:'Read the choir preview.'},{label:'iris@example.test',address:'other@example.test'}),null);
 assert.ok(enforceSender(emailTask,{need:'Read the choir preview.'},{label:'Iris',address:'iris@example.test'}));
 const freeform={goal:'Use what notices@example.test has sent me to summarize choir updates.'};
 assert.equal(enforceSender(freeform,{need:freeform.goal},null),null);
 assert.equal(enforceSender(freeform,{need:freeform.goal},{label:'notices@example.test',address:'other@example.test'}),null);
 assert.equal(enforceSender(freeform,{need:freeform.goal},{label:'Choir office',address:'notices@different.example.test'}),null);
 assert.equal(enforceSender(freeform,{need:freeform.goal},{label:'Choir office',address:'notices@example.test'}).goal,freeform.goal);
 assert.equal(enforceSender({goal:'Read messages mentioning notices@example.test.'},{need:'Read that preview.'},{label:'Office',address:'notices@example.test'}),null);
 assert.equal(enforceSender({goal:'Read mail from "quoted address"@example.test.'},{need:'Read that preview.'},{label:'Office',address:'"quoted address"@example.test'}),null);
});
test('recipient phrases bind to the following mailbox rather than an author-purpose infinitive',()=>{
 const header={label:'Different display name',address:'letters@example.test'};
 for(const goal of ['Use the mail letters@example.test has sent to brief me about rehearsal.',
  'Use letters@example.test’s correspondence to tell me about rehearsal.']) {
  assert.equal(enforceSender({goal},{need:goal},header)?.goal,goal);
  assert.equal(enforceSender({goal},{need:goal},{...header,address:'other@example.test'}),null);
 }
 for(const goal of ['Read mail sent to letters@example.test.',
  'Read mail addressed to the office at letters@example.test.',
  'Read letters@example.test’s mail sent to letters@example.test.',
  'Read correspondence with letters@example.test as its recipient.'])
  assert.equal(enforceSender({goal},{need:goal},header),null);
 const task={goal:'Read letters@example.test’s correspondence about rehearsal.'};
 assert.equal(enforceSender(task,{need:'Read messages sent to letters@example.test.'},header),null);
});
test('observed header metadata has a bounded, explicit envelope independent of the body',()=>{
 assert.equal(sourceContext('Inbox',{label:'Iris',address:'iris@example.test'}),'{"folder":"Inbox","sender":{"label":"Iris","address":"iris@example.test"}}');
 assert.equal(sourceContext('Inbox',null),'{"folder":"Inbox","sender":null}');
 assert.throws(()=>sourceContext('Inbox',{label:'Iris',address:'iris@example.test',approved:true}));
 assert.throws(()=>sourceContext('Inbox',{label:'x'.repeat(101),address:''}));
 assert.throws(()=>sourceContext('Inbox '+'x'.repeat(181),null));
 assert.throws(()=>sourceContext({approved:'Inbox'},null));
});
