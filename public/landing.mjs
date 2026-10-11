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
const modeNames = {record: 'Record only', balanced: 'Balanced', careful: 'Careful'};
let selectedMode = 'record';
let scenario = 'send';

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
    request: 'CONNECT · 01 / 03',
    view: 'CLOUD BROWSER · 02 / 03',
    action: 'TASK DECISION · 03 / 03',
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
  showStage('done', `${title}. ${message}`, true);
}

function renderDecision() {
  const isSend = scenario === 'send';
  const asks = isSend ? selectedMode !== 'record' : selectedMode === 'careful';
  for (const button of document.querySelectorAll('[data-scenario]')) {
    button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario));
  }
  document.getElementById('demoSendAction').hidden = !isSend;
  document.getElementById('demoBrowseAction').hidden = isSend;
  document.getElementById('demoConfirmActions').hidden = !asks;
  document.getElementById('continueAction').hidden = asks;

  const decision = document.getElementById('demoDecisionResult');
  const heading = document.getElementById('demoActionHeading');
  const explanation = document.getElementById('demoActionExplanation');
  if (asks) {
    decision.textContent = `${modeNames[selectedMode]} · asks for your confirmation`;
    heading.textContent = isSend ? 'Review the exact send.' : 'Step in below 98% confidence.';
    explanation.textContent = isSend
      ? 'Sending a reply is sensitive, so this setting asks you before the action continues.'
      : 'This relevant, nonsensitive action has 94% model confidence. Careful asks you before continuing.';
  } else {
    decision.textContent = `${modeNames[selectedMode]} · ${selectedMode === 'record' ? 'record and continue' : 'continue'}`;
    heading.textContent = selectedMode === 'record' ? 'Recorded without a pause.' : 'Continue within the task.';
    explanation.textContent = selectedMode === 'record'
      ? 'Record only classifies and records this eligible action without stopping it for confirmation.'
      : 'Balanced allows this relevant, nonsensitive action to continue without confirmation.';
  }
  status.textContent = `${decision.textContent}. ${explanation.textContent}`;
}

document.getElementById('connectDemo').addEventListener('click', () => {
  selectedMode = document.querySelector('input[name="demoMode"]:checked').value;
  showStage('view', `${modeNames[selectedMode]} selected. Open the fictional owner Live View to sign in.`, true);
});
document.getElementById('demoOpenLive').addEventListener('click', () => {
  document.getElementById('demoSignIn').hidden = true;
  document.getElementById('demoLiveView').hidden = false;
  status.textContent = 'Owner Live View is open in this fictional browser. Complete the demo sign-in to continue.';
  document.getElementById('demoCompleteSignIn').focus();
});
document.getElementById('demoCompleteSignIn').addEventListener('click', () => {
  document.getElementById('demoLiveView').hidden = true;
  document.getElementById('demoSignedIn').hidden = false;
  document.getElementById('demoContinue').hidden = false;
  status.textContent = 'Signed in through the fictional owner Live View. The assistant sees a filtered task view.';
  document.getElementById('demoContinue').focus();
});
document.getElementById('demoContinue').addEventListener('click', () => {
  renderDecision();
  showStage('action', status.textContent, true);
});
for (const button of document.querySelectorAll('[data-scenario]')) {
  button.addEventListener('click', () => {
    scenario = button.dataset.scenario;
    renderDecision();
  });
}
document.getElementById('approveAction').addEventListener('click', () => {
  finish('Demo action approved', 'The fictional action continued. This page changed no real website.');
});
document.getElementById('denyAction').addEventListener('click', () => {
  finish('Demo action denied', 'The fictional action stopped. This page changed no real website.');
});
document.getElementById('continueAction').addEventListener('click', () => {
  finish('Demo complete', 'The fictional action continued under your selected setting. This page changed no real website.');
});
for (const id of ['resetDemo', 'repeatDemo']) {
  document.getElementById(id).addEventListener('click', () => {
    document.querySelector('input[name="demoMode"][value="record"]').checked = true;
    document.getElementById('demoSignIn').hidden = false;
    document.getElementById('demoLiveView').hidden = true;
    document.getElementById('demoSignedIn').hidden = true;
    document.getElementById('demoContinue').hidden = true;
    selectedMode = 'record';
    scenario = 'send';
    showStage('request', 'Demo reset. Choose a confirmation level to start.', true);
  });
}
showStage('request', 'Choose a confirmation level to start the demo.');
