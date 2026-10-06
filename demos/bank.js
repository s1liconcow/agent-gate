const sections=['bankLogin','bankHome','bankContacts','bankAmount','bankReview','bankDone'];
const show=id=>{for(const key of sections)document.getElementById(key).hidden=key!==id;};
document.getElementById('bankUnlock').onclick=()=>show('bankHome');
document.getElementById('bankZelle').onclick=()=>show('bankContacts');
document.getElementById('bankAli').onclick=()=>show('bankAmount');
let payment;
document.getElementById('bankPaymentForm').onsubmit=event=>{
  event.preventDefault();const amount=Number(document.getElementById('bankAmountValue').value),memo=document.getElementById('bankMemo').value;
  if(!Number.isFinite(amount)||amount<=0||amount>10000)return;
  payment={recipient:'Ali',amount:amount.toFixed(2),memo};
  document.getElementById('bankReceipt').textContent=`Recipient: Ali · Amount: $${payment.amount} · Memo: ${memo}`;
  document.getElementById('bankSend').textContent=`Send $${payment.amount} to Ali`;show('bankReview');
};
document.getElementById('bankSend').onclick=event=>{
  if(!payment||event.currentTarget.disabled)return;event.currentTarget.disabled=true;
  const records=JSON.parse(localStorage.getItem('synthetic-bank-records')||'[]');records.push({...payment,id:crypto.randomUUID(),at:new Date().toISOString()});localStorage.setItem('synthetic-bank-records',JSON.stringify(records));show('bankDone');
};
