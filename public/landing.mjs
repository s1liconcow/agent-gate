const panels = {
  request: document.getElementById('demoRequest'),
  view: document.getElementById('demoView'),
  action: document.getElementById('demoAction'),
  done: document.getElementById('demoDone'),
};
const steps = [...document.querySelectorAll('.demo-step')];
const label = document.getElementById('demoStageLabel');
const status = document.getElementById('demoStatus');
const resultTitle = document.getElementById('demoResultTitle');
const resultText = document.getElementById('demoResultText');
const stageOrder = ['request', 'view', 'action'];

function showStage(stage, announcement, moveFocus = false) {
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== stage;
  const currentIndex = stageOrder.indexOf(stage);
  for (const step of steps) {
    const index = stageOrder.indexOf(step.dataset.step);
    step.classList.toggle('is-current', index === currentIndex);
    step.classList.toggle('is-complete', stage === 'done' || (currentIndex >= 0 && index < currentIndex));
    if (index === currentIndex) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
  label.textContent = {
    request: 'PHONE APPROVAL · 01 / 03',
    view: 'BOUNDED VIEW · 02 / 03',
    action: 'EXACT ACTION · 03 / 03',
    done: 'WALKTHROUGH COMPLETE',
  }[stage];
  status.textContent = announcement;
  if (moveFocus) {
    panels[stage].setAttribute('role', 'region');
    panels[stage].setAttribute('aria-label', label.textContent);
    panels[stage].tabIndex = -1;
    panels[stage].focus({preventScroll: true});
  }
}

function finish(title, message) {
  resultTitle.textContent = title;
  resultText.textContent = message;
  showStage('done', title + '. ' + message, true);
}

document.getElementById('approveTask').addEventListener('click', () => {
  showStage('view', 'Scoped task approved. The assistant can now read the bounded synthetic view.', true);
});
document.getElementById('denyTask').addEventListener('click', () => {
  finish('Request denied', 'The fictional assistant received no browser view. No real data was accessed.');
});
document.getElementById('prepareReply').addEventListener('click', () => {
  showStage('action', 'A synthetic reply is ready. The exact send action awaits phone approval.', true);
});
document.getElementById('approveAction').addEventListener('click', () => {
  finish('Demo complete', 'The fictional reply was sent in this walkthrough. No real message left this page.');
});
document.getElementById('denyAction').addEventListener('click', () => {
  finish('Action denied', 'The fictional draft stayed unsent. No real message left this page.');
});
for (const id of ['resetDemo', 'repeatDemo']) {
  document.getElementById(id).addEventListener('click', () => {
    showStage('request', 'Demo reset. Waiting for your scoped task approval.', true);
  });
}
showStage('request', 'Waiting for your demo approval.');
