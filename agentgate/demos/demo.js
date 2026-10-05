const task = new URLSearchParams(location.search).get('task') || 'mail';
document.getElementById('unlock').addEventListener('click', () => { document.getElementById('locked').hidden = true; document.getElementById(['mail', 'calendar', 'payment'].includes(task) ? task : 'mail').hidden = false; });
for (const [formId, outcomeId, label] of [['mailForm', 'mailOutcome', 'Demo email recorded'], ['calendarForm', 'calendarOutcome', 'Demo event recorded'], ['paymentForm', 'paymentOutcome', 'Demo payment recorded']]) {
  document.getElementById(formId).addEventListener('submit', event => {
    event.preventDefault();
    if (event.submitter.disabled) return;
    const fields = Object.fromEntries([...event.target.querySelectorAll('input,textarea')].map(node => [node.id, node.value]));
    const record = {id: crypto.randomUUID(), fields, at: new Date().toISOString()};
    const records = JSON.parse(localStorage.getItem('synthetic-records') || '[]'); records.push(record); localStorage.setItem('synthetic-records', JSON.stringify(records));
    document.getElementById(outcomeId).textContent = label + '. Nothing was sent to an external service.'; event.submitter.disabled = true;
  });
}
