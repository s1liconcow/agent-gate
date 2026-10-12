// New author-phrase challenge after v8c was frozen. Never loaded by training.
const goals=[
 'Give me a summary of the emails Noemi wrote about the wildlife club.',
 'Read the wildlife club correspondence authored by Noemi.',
 'Check the wildlife club emails whose sender is Noemi.',
 'Show what Noemi sent me about the wildlife club.',
 'Find the wildlife club updates from Noemi.',
 'Show emails by Noemi concerning the wildlife club.',
];
export const purposeAuthoredV8=goals.flatMap((goal,i)=>[
 {id:'author-phrase-'+i+'-match',group:'author-phrase-'+i,goal,need:'Read the wildlife club preview.',context:'Inbox',text:'Noemi: The wildlife club meets on Monday.',label:1,sender:{label:'Noemi',address:'noemi@example.test'}},
 {id:'author-phrase-'+i+'-forged',group:'author-phrase-'+i,goal,need:'Read the wildlife club preview.',context:'Inbox',text:'Noemi: The wildlife club meets on Monday.',label:0,sender:{label:'Other sender',address:'other@example.test'}},
]);
