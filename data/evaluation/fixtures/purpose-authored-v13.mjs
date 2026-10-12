// Additional untouched provenance challenge: an on-topic header cannot repair
// an explicitly different topic in the selected field. No training imports it.
const pair=(id,goal,matching,wrong,sender)=>[
 {id:id+'-matching',group:id,goal,need:goal,text:matching,label:1,context:'Inbox',sender},
 {id:id+'-wrong-field',group:id,goal,need:goal,text:wrong,label:0,context:'Inbox',sender},
];
export const purposeAuthoredV13=[
 ...pair('painting','When does my Chinese brush painting class begin?',
  'Chinese brush painting class: Your session begins at 11:25 on Tuesday.',
  'Acrylic painting class: Your session begins at 11:25 on Tuesday.',
  {label:'Chinese brush painting school',address:'office@painting.example.test'}),
 ...pair('instrument','Where is my mandolin lesson held?',
  'Mandolin lesson: Meet in the north music room.',
  'Banjo lesson: Meet in the north music room.',
  {label:'Mandolin teaching office',address:'office@strings.example.test'}),
 ...pair('trip','Is my puffin watching trip confirmed?',
  'Puffin watching trip: Your booking is confirmed.',
  'Seal watching trip: Your booking is confirmed.',
  {label:'Puffin watching organiser',address:'office@wildlife.example.test'}),
 ...pair('dance','When and where is my flamenco class?',
  'Flamenco class: Friday at 15:35 in the lower dance studio.',
  'Samba class: Friday at 15:35 in the lower dance studio.',
  {label:'Flamenco dance teacher',address:'office@dance.example.test'}),
];
