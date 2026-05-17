const APP_VERSION = 'v0.5';
document.getElementById('version-header').textContent = APP_VERSION;
document.getElementById('version-footer').textContent = APP_VERSION;

let data = {crates:[], conversionRate:0};
const collapsed = new Set();
let undoStack = null;
let undoTimer = null;
const itemSort = {};
let dragSrcId = null;
let lastSaved = null;
const pendingDelete = new Set();

/* ── Default shared bins (read-only access key embedded) ── */
const DEFAULT_BINS = [
  // { id:'shared-main', name:'Main Shared Bin', binId:'YOUR_BIN_ID', accessKey:'YOUR_READ_ONLY_KEY', isDefault:true }
  { id:'SkinMonkey', name:'SkinMonkey', binId:'6a0894c8c0954111d8322e6b', accessKey:'$2a$10$ILPMp765fnUcaEdQyFS21OQqsuDfqvwa4Qb94FtdJ.c06B2i5TIvK', isDefault:true }
];

/* ── Bin storage (per-browser, in localStorage) ── */
let bins = [];         // [{id, name, accessKey, binId}] — user-added bins
let keyOverrides = {}; // {[bin.id]: 'write-access-key'} — per-user key overrides for any bin
let activeBinId = null;

function loadBinConfig(){
  try{
    const s=localStorage.getItem('loot_crate_bins');
    if(s) bins=JSON.parse(s);
    const k=localStorage.getItem('loot_crate_key_overrides');
    if(k) keyOverrides=JSON.parse(k);
    activeBinId=localStorage.getItem('loot_crate_active_bin')||null;
  }catch(e){}
}
function saveBinConfig(){
  localStorage.setItem('loot_crate_bins',JSON.stringify(bins));
  localStorage.setItem('loot_crate_key_overrides',JSON.stringify(keyOverrides));
  localStorage.setItem('loot_crate_active_bin',activeBinId||'');
}
function getAllBins(){ return [...DEFAULT_BINS,...bins]; }
function getActiveBin(){ return getAllBins().find(b=>b.id===activeBinId)||null; }
function getEffectiveKey(bin){ return keyOverrides[bin.id]||bin.accessKey; }
function canWrite(bin){ return bin.isDefault ? !!keyOverrides[bin.id] : true; }

/* ── JSONBin API ── */
function friendlyError(status){
  if(status===401||status===403) return 'Wrong access key';
  if(status===404) return 'Bin not found';
  if(status===429) return 'Rate limit hit — try again shortly';
  return `Server error (HTTP ${status})`;
}
async function fetchBin(bin){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),10000);
  try{
    const res=await fetch(`https://api.jsonbin.io/v3/b/${bin.binId}/latest`,{
      headers:{'X-Access-Key':getEffectiveKey(bin)},
      signal:ctrl.signal
    });
    if(!res.ok) throw new Error(friendlyError(res.status));
    const j=await res.json();
    return j.record;
  }catch(e){
    if(e.name==='AbortError') throw new Error('Request timed out');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}
async function pushBin(bin,payload){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),10000);
  try{
    const res=await fetch(`https://api.jsonbin.io/v3/b/${bin.binId}`,{
      method:'PUT',
      headers:{'X-Access-Key':getEffectiveKey(bin),'Content-Type':'application/json'},
      body:JSON.stringify(payload),
      signal:ctrl.signal
    });
    if(!res.ok) throw new Error(friendlyError(res.status));
  }catch(e){
    if(e.name==='AbortError') throw new Error('Request timed out');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

/* ── Bin status UI ── */
function setBinStatus(state,label='',writable=true){
  const el=document.getElementById('bin-status');
  const txt=document.getElementById('bin-status-text');
  const saveBtn=document.getElementById('save-bin-btn');
  el.className='bin-status';
  if(state==='connected'){
    el.classList.add('visible','connected');
    txt.textContent=`Connected to ${label}${relativeTime(lastSaved)}`;
    if(writable) saveBtn.classList.add('visible');
    else saveBtn.classList.remove('visible');
  } else if(state==='saving'){
    el.classList.add('visible','saving');
    txt.textContent='Saving…';
  } else if(state==='error'){
    el.classList.add('visible','error');
    txt.textContent=label||'Connection error';
    saveBtn.classList.remove('visible');
  } else {
    saveBtn.classList.remove('visible');
  }
}

/* ── Connect / load ── */
async function connectBin(id){
  activeBinId=id;
  saveBinConfig();
  const bin=getActiveBin();
  if(!bin) return;
  setBinStatus('saving');
  try{
    const record=await fetchBin(bin);
    if(record&&Array.isArray(record.crates)){ data=record; save(); render(); }
    setBinStatus('connected',bin.name,canWrite(bin));
    showToast(`Loaded from "${bin.name}"`);
  }catch(e){
    setBinStatus('error',`Failed to load (${e.message})`);
    showToast(`Could not reach bin: ${e.message}`,true);
  }
  renderBinsList();
}

function disconnectBin(){
  activeBinId=null;
  saveBinConfig();
  setBinStatus('');
  renderBinsList();
}

async function saveToActiveBin(){
  const bin=getActiveBin();
  if(!bin) return;
  if(!canWrite(bin)){ showToast('This bin is read-only — set a write key first',true); return; }
  const btn=document.getElementById('save-bin-btn');
  btn.disabled=true;
  setBinStatus('saving');
  try{
    await pushBin(bin,data);
    lastSaved=Date.now();
    setBinStatus('connected',bin.name,true);
    showToast(`Saved to "${bin.name}"`);
  }catch(e){
    setBinStatus('error',`Save failed (${e.message})`);
    showToast(`Save failed: ${e.message}`,true);
  }
  btn.disabled=false;
}

/* ── Key override ── */
function toggleOverrideInput(id){
  const row=document.getElementById(`override-row-${id}`);
  if(row) row.style.display=row.style.display==='none'?'flex':'none';
}
function setOverrideKey(id){
  const input=document.getElementById(`override-input-${id}`);
  const key=input?input.value.trim():'';
  if(!key){ showToast('Enter a key first',true); return; }
  keyOverrides[id]=key;
  saveBinConfig();
  const bin=getActiveBin();
  if(bin&&bin.id===id) setBinStatus('connected',bin.name,true);
  showToast('Write key saved');
  renderBinsList();
}
function clearOverrideKey(id){
  delete keyOverrides[id];
  saveBinConfig();
  const bin=getActiveBin();
  if(bin&&bin.id===id) setBinStatus('connected',bin.name,canWrite(bin));
  renderBinsList();
}

/* ── Bins modal ── */
function openBinsModal(){ renderBinsList(); document.getElementById('bins-modal').style.display='flex'; }
function closeBinsModal(){ document.getElementById('bins-modal').style.display='none'; }
function handleModalOverlayClick(e){ if(e.target===e.currentTarget) closeBinsModal(); }

function renderBinItem(b,canRemove){
  const active=b.id===activeBinId;
  const hasOverride=!!keyOverrides[b.id];
  const badge=b.isDefault
    ?(hasOverride?`<span class="bin-badge write">Write access</span>`:`<span class="bin-badge readonly">Read only</span>`)
    :'';
  return `<div class="bin-item${active?' is-active':''}">
    <div class="bin-item-main">
      <div class="bin-item-info">
        <div class="bin-item-name">${esc(b.name)}${badge}${active?'<span class="bin-active-tag">(active)</span>':''}</div>
        <div class="bin-item-id">${b.binId}</div>
      </div>
      <div class="bin-actions">
        <button class="del-crate-btn" onclick="toggleOverrideInput('${b.id}')" title="${hasOverride?'Edit write key':'Set write key'}">
          <i class="ti ti-key" style="font-size:11px"></i> ${hasOverride?'Key set':'Set key'}
        </button>
        ${active
          ?`<button class="del-crate-btn" onclick="disconnectBin()">Disconnect</button>`
          :`<button class="add-btn" style="border-style:solid" onclick="connectBin('${b.id}')"><i class="ti ti-plug"></i> Connect</button>`
        }
        ${canRemove?`<button class="del-crate-btn" onclick="removeBin('${b.id}')"><i class="ti ti-trash" style="font-size:12px"></i></button>`:''}
      </div>
    </div>
    <div class="override-row" id="override-row-${b.id}" style="display:none">
      <input type="password" id="override-input-${b.id}" placeholder="Write access key…">
      <button class="primary-modal-btn" style="padding:6px 12px;font-size:12px" onclick="setOverrideKey('${b.id}')">Save</button>
      ${hasOverride?`<button class="del-crate-btn" onclick="clearOverrideKey('${b.id}')">Clear</button>`:''}
    </div>
  </div>`;
}

function renderBinsList(){
  const el=document.getElementById('bins-list');
  const hasDefaults=DEFAULT_BINS.length>0;
  const hasUserBins=bins.length>0;
  if(!hasDefaults&&!hasUserBins){
    el.innerHTML='<div class="empty-bins"><i class="ti ti-database-off" style="font-size:24px;display:block;margin-bottom:6px;opacity:.4"></i>No bins added yet.</div>';
    return;
  }
  let html='';
  if(hasDefaults){
    html+=`<div class="bin-section-title">Shared bins</div>`;
    html+=DEFAULT_BINS.map(b=>renderBinItem(b,false)).join('');
  }
  if(hasUserBins){
    html+=`<div class="bin-section-title"${hasDefaults?' style="margin-top:14px"':''}>My bins</div>`;
    html+=bins.map(b=>renderBinItem(b,true)).join('');
  }
  el.innerHTML=html;
}

function addBin(){
  const name=document.getElementById('bin-input-name').value.trim();
  const accessKey=document.getElementById('bin-input-key').value.trim();
  const binId=document.getElementById('bin-input-id').value.trim();
  if(!name||!accessKey||!binId){ showToast('Please fill in all three fields',true); return; }
  bins.push({id:uid(),name,accessKey,binId});
  saveBinConfig();
  document.getElementById('bin-input-name').value='';
  document.getElementById('bin-input-key').value='';
  document.getElementById('bin-input-id').value='';
  renderBinsList();
}

function removeBin(id){
  if(activeBinId===id){ activeBinId=null; setBinStatus(''); }
  bins=bins.filter(b=>b.id!==id);
  delete keyOverrides[id];
  saveBinConfig();
  renderBinsList();
}

function toggleCollapse(cid){
  collapsed.has(cid)?collapsed.delete(cid):collapsed.add(cid);
  renderCrates();updateAllCostDisplays();
}
function collapseAll(){ data.crates.forEach(c=>collapsed.add(c.id)); renderCrates();updateAllCostDisplays(); }
function expandAll(){ collapsed.clear(); renderCrates();updateAllCostDisplays(); }

function load(){
  try{const s=localStorage.getItem('loot_crate_data');if(s)data=JSON.parse(s);}catch(e){}
  if(!data.crates||data.crates.length===0){
    data={...data,crates:[{id:uid(),name:'Crate A',cost:100,items:[{id:uid(),name:'Common item',chance:60,value:50},{id:uid(),name:'Rare item',chance:30,value:150},{id:uid(),name:'Legendary',chance:10,value:500}]}]};
  }
  if(!data.conversionRate) data.conversionRate=0;
  const rateInput=document.getElementById('conversion-rate');
  if(rateInput&&data.conversionRate>0) rateInput.value=data.conversionRate;
}

function save(){
  try{localStorage.setItem('loot_crate_data',JSON.stringify(data));}catch(e){}
}

function uid(){return Math.random().toString(36).slice(2,9)}

function addCrate(){
  data.crates.push({id:uid(),name:'New crate',cost:100,items:[]});
  save();render();
}

function deleteCrate(cid){
  const index=data.crates.findIndex(c=>c.id===cid);
  if(index===-1)return;
  undoStack={type:'crate',data:JSON.parse(JSON.stringify(data.crates[index])),index};
  clearTimeout(undoTimer);
  undoTimer=setTimeout(()=>{undoStack=null;},5000);
  data.crates=data.crates.filter(c=>c.id!==cid);
  pendingDelete.delete(cid);
  delete itemSort[cid];
  save();render();
  showToast('Crate deleted',false,{label:'Undo',fn:'undoDelete'});
}

function duplicateCrate(cid){
  const index=data.crates.findIndex(c=>c.id===cid);
  if(index===-1)return;
  const clone=JSON.parse(JSON.stringify(data.crates[index]));
  clone.id=uid();
  clone.name=clone.name+' (copy)';
  clone.items=clone.items.map(it=>({...it,id:uid()}));
  data.crates.splice(index+1,0,clone);
  save();render();
}

function confirmDeleteCrate(cid){
  if(pendingDelete.has(cid)){ deleteCrate(cid); return; }
  pendingDelete.add(cid);
  const btn=document.querySelector(`[data-cid="${cid}"] .del-confirm-btn`);
  if(btn){ btn.textContent='Confirm?'; btn.classList.add('is-confirming'); }
  setTimeout(()=>{ pendingDelete.delete(cid); const b=document.querySelector(`[data-cid="${cid}"] .del-confirm-btn`); if(b){ b.innerHTML='<i class="ti ti-trash" style="font-size:13px"></i> Remove'; b.classList.remove('is-confirming'); } }, 3000);
}

function addItem(cid){
  const c=data.crates.find(c=>c.id===cid);
  if(c)c.items.push({id:uid(),name:'New item',chance:10,value:100});
  save();render();
}

function deleteItem(cid,iid){
  const c=data.crates.find(c=>c.id===cid);
  if(!c)return;
  const index=c.items.findIndex(i=>i.id===iid);
  if(index===-1)return;
  undoStack={type:'item',cid,data:JSON.parse(JSON.stringify(c.items[index])),index};
  clearTimeout(undoTimer);
  undoTimer=setTimeout(()=>{undoStack=null;},5000);
  c.items=c.items.filter(i=>i.id!==iid);
  save();render();
  showToast('Item deleted',false,{label:'Undo',fn:'undoDelete'});
}

function duplicateItem(cid,iid){
  const c=data.crates.find(c=>c.id===cid);
  if(!c)return;
  const index=c.items.findIndex(i=>i.id===iid);
  if(index===-1)return;
  const clone=JSON.parse(JSON.stringify(c.items[index]));
  clone.id=uid();
  c.items.splice(index+1,0,clone);
  save();render();
}

function undoDelete(){
  if(!undoStack)return;
  clearTimeout(undoTimer);
  if(undoStack.type==='crate'){
    data.crates.splice(undoStack.index,0,undoStack.data);
  } else if(undoStack.type==='item'){
    const c=data.crates.find(c=>c.id===undoStack.cid);
    if(c) c.items.splice(undoStack.index,0,undoStack.data);
  }
  undoStack=null;
  save();render();
  showToast('Restored');
}

function setConversionRate(val){
  data.conversionRate=parseFloat(val)||0;
  save();
  updateAllCostDisplays();
}

function updateCostDisplay(cid){
  const c=data.crates.find(c=>c.id===cid);
  if(!c)return;
  const el=document.getElementById(`cost-gbp-${cid}`);
  if(!el)return;
  const rate=data.conversionRate||0;
  el.textContent=rate>0?`= £${(c.cost*rate).toFixed(2)}`:'';
  el.style.display=rate>0?'':'none';
}

function updateAllCostDisplays(){
  const preview=document.getElementById('cb-preview');
  const rate=data.conversionRate||0;
  if(preview){
    if(rate>0){preview.textContent=`100 pts = £${(100*rate).toFixed(2)}`;preview.style.display='';}
    else preview.style.display='none';
  }
  data.crates.forEach(c=>updateCostDisplay(c.id));
}

function updateCrate(cid,field,val){
  if(!['name','cost'].includes(field)) return;
  const c=data.crates.find(c=>c.id===cid);
  if(!c)return;
  c[field]=field==='cost'?Math.max(0,parseFloat(val)||0):val;
  save();renderResults();
  if(field==='cost') updateCostDisplay(cid);
}

function updateItem(cid,iid,field,val){
  if(!['name','chance','value'].includes(field)) return;
  const c=data.crates.find(c=>c.id===cid);
  if(!c)return;
  const it=c.items.find(i=>i.id===iid);
  if(!it)return;
  if(field==='name') it.name=val;
  else if(field==='chance') it.chance=Math.min(100,Math.max(0,parseFloat(val)||0));
  else if(field==='value') it.value=Math.max(0,parseFloat(val)||0);
  save();renderResults();updateWarning(cid);
}

function updateWarning(cid){
  const c=data.crates.find(c=>c.id===cid);
  if(!c)return;
  const slot=document.querySelector(`[data-cid="${cid}"] .warn-slot`);
  if(!slot)return;
  const{totalChance}=calcEV(c);
  slot.innerHTML=totalChance>100
    ?`<div class="error"><i class="ti ti-alert-triangle"></i> Chances sum to ${totalChance.toFixed(1)}% (exceeds 100%)</div>`
    :totalChance<100
      ?`<div class="warning"><i class="ti ti-info-circle"></i> Chances sum to ${totalChance.toFixed(1)}% — remaining ${(100-totalChance).toFixed(1)}% yields nothing</div>`
      :'';
}

function calcEV(crate){
  if(!crate.items.length)return{ev:0,totalChance:0};
  const totalChance=crate.items.reduce((a,i)=>a+i.chance,0);
  const ev=crate.items.reduce((a,i)=>a+(i.chance/100)*i.value,0);
  return{ev,totalChance};
}

function sortItems(cid,col){
  if(itemSort[cid]&&itemSort[cid].col===col){
    itemSort[cid].dir=itemSort[cid].dir===1?-1:1;
  } else {
    itemSort[cid]={col,dir:1};
  }
  renderCrates();updateAllCostDisplays();
}

function sortArrow(cid,col){
  if(!itemSort[cid]||itemSort[cid].col!==col) return '<span style="opacity:.3">&#x21D5;</span>';
  return itemSort[cid].dir===1?'&#x2191;':'&#x2193;';
}

function onDragStart(e,cid){ dragSrcId=cid; e.dataTransfer.effectAllowed='move'; }
function onDragOver(e,cid){ e.preventDefault(); document.querySelectorAll('.card').forEach(el=>el.classList.remove('drag-over')); const card=document.querySelector(`[data-cid="${cid}"]`); if(card&&cid!==dragSrcId) card.classList.add('drag-over'); }
function onDrop(e,cid){ e.preventDefault(); document.querySelectorAll('.card').forEach(el=>el.classList.remove('drag-over')); if(!dragSrcId||dragSrcId===cid) return; const from=data.crates.findIndex(c=>c.id===dragSrcId); const to=data.crates.findIndex(c=>c.id===cid); if(from===-1||to===-1) return; const [moved]=data.crates.splice(from,1); data.crates.splice(to,0,moved); dragSrcId=null; save(); render(); }
function onDragEnd(){ document.querySelectorAll('.card').forEach(el=>el.classList.remove('drag-over')); dragSrcId=null; }

function renderCrates(){
  const el=document.getElementById('crates-container');
  const rate=data.conversionRate||0;
  el.innerHTML=data.crates.map(c=>{
    const {ev,totalChance}=calcEV(c);
    const isCollapsed=collapsed.has(c.id);
    const costGbp=rate>0?c.cost*rate:null;
    const roi=c.cost>0?((ev-(costGbp??c.cost))/(costGbp??c.cost)*100):null;

    const warn=totalChance>100
      ?`<div class="error"><i class="ti ti-alert-triangle"></i> Chances sum to ${totalChance.toFixed(1)}% (exceeds 100%)</div>`
      :totalChance<100
        ?`<div class="warning"><i class="ti ti-info-circle"></i> Chances sum to ${totalChance.toFixed(1)}% — remaining ${(100-totalChance).toFixed(1)}% yields nothing</div>`
        :'';

    const sortState=itemSort[c.id];
    const sortedItems=sortState?[...c.items].sort((a,b)=>{
      const v=sortState.col==='ev'?(it=>((it.chance/100)*it.value)):sortState.col==='value'?(it=>it.value):(it=>it.chance);
      return (v(a)-v(b))*sortState.dir;
    }):c.items;

    const rows=sortedItems.map(it=>`
      <tr>
        <td><input type="text" value="${esc(it.name)}" oninput="updateItem('${c.id}','${it.id}','name',this.value)"></td>
        <td><input type="number" min="0" max="100" step="0.01" value="${it.chance}" oninput="updateItem('${c.id}','${it.id}','chance',this.value)"></td>
        <td><div class="input-pfx"><span class="pfx">£</span><input type="number" min="0" step="0.01" value="${it.value}" oninput="updateItem('${c.id}','${it.id}','value',this.value)"></div></td>
        <td class="ev-contrib">£${((it.chance/100)*it.value).toFixed(2)}</td>
        <td><button class="del-btn" onclick="duplicateItem('${c.id}','${it.id}')" title="Duplicate item" style="font-size:13px"><i class="ti ti-copy"></i></button><button class="del-crate-btn" onclick="deleteItem('${c.id}','${it.id}')" aria-label="Remove item">Remove</button></td>
      </tr>`).join('');

    const preview=`<div class="collapsed-preview">
      <div class="cp-stat"><span class="cp-label">Items</span><span class="cp-val">${c.items.length}</span></div>
      <div class="cp-stat"><span class="cp-label">Cost</span><span class="cp-val"><i class="ti ti-coin" style="color:var(--amber);font-size:13px"></i> ${c.cost} pts${costGbp!=null?` <span style="font-weight:400;color:var(--muted);font-size:12px">= £${costGbp.toFixed(2)}</span>`:''}</span></div>
      <div class="cp-stat"><span class="cp-label">Exp. Value</span><span class="cp-val">£${ev.toFixed(2)}</span></div>
      ${roi!=null?`<div class="cp-stat"><span class="cp-label">ROI</span><span class="cp-val" style="color:${roi>=0?'#16a34a':'#dc2626'}">${roi>=0?'+':''}${roi.toFixed(1)}%</span></div>`:''}
    </div>`;

    const body=`<div class="meta-row">
        <div class="meta-field">
          <label><i class="ti ti-coin" style="color:var(--amber)"></i> Cost to open (pts)</label>
          <div style="display:flex;align-items:center;gap:8px">
            <div class="input-pfx"><span class="pfx coin"><i class="ti ti-coin"></i></span><input type="number" min="0" step="1" value="${c.cost}" oninput="updateCrate('${c.id}','cost',this.value)"></div>
            <span class="cost-gbp" id="cost-gbp-${c.id}"></span>
          </div>
        </div>
        <div class="ev-chip">
          <div class="ev-label">Expected value (£)</div>
          <span class="ev-val">£${ev.toFixed(2)}</span>
          <span class="ev-sub"> / open</span>
        </div>
      </div>
      <div class="warn-slot">${warn}</div>
      <table class="items-table">
        <thead><tr>
          <th>Item name</th>
          <th style="cursor:pointer;user-select:none" onclick="sortItems('${c.id}','chance')">Chance (%) ${sortArrow(c.id,'chance')}</th>
          <th style="cursor:pointer;user-select:none" onclick="sortItems('${c.id}','value')">Value (£) ${sortArrow(c.id,'value')}</th>
          <th style="cursor:pointer;user-select:none" onclick="sortItems('${c.id}','ev')">EV contrib. (£) ${sortArrow(c.id,'ev')}</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:12px">
        <button class="add-btn" onclick="addItem('${c.id}')"><i class="ti ti-plus"></i> Add item</button>
      </div>`;

    return `<div class="card" data-cid="${c.id}" ondragover="onDragOver(event,'${c.id}')" ondrop="onDrop(event,'${c.id}')" ondragend="onDragEnd()">
      <div class="crate-header${isCollapsed?'':' is-expanded'}">
        <div class="drag-handle" draggable="true" ondragstart="onDragStart(event,'${c.id}')" title="Drag to reorder"><i class="ti ti-grip-vertical"></i></div>
        <button class="collapse-btn" onclick="toggleCollapse('${c.id}')" aria-label="${isCollapsed?'Expand':'Collapse'} crate">
          <i class="ti ti-chevron-${isCollapsed?'right':'down'}"></i>
        </button>
        <div class="crate-icon"><i class="ti ti-package"></i></div>
        <input class="crate-name-input" value="${esc(c.name)}" oninput="updateCrate('${c.id}','name',this.value)" placeholder="Crate name">
        <button class="del-crate-btn" onclick="duplicateCrate('${c.id}')" title="Duplicate crate"><i class="ti ti-copy" style="font-size:13px"></i></button>
        <button class="del-crate-btn del-confirm-btn" onclick="confirmDeleteCrate('${c.id}')"><i class="ti ti-trash" style="font-size:13px"></i> Remove</button>
      </div>
      ${isCollapsed?preview:body}
    </div>`;
  }).join('');
}

function renderResults(){
  const el=document.getElementById('results-container');
  const valid=data.crates.filter(c=>c.items.length>0&&c.cost>0);
  if(!valid.length){
    el.innerHTML='<div class="empty-state"><i class="ti ti-chart-bar"></i>Add at least one crate with items and a non-zero cost to see results.</div>';
    return;
  }

  const rate=data.conversionRate||0;
  const results=valid.map(c=>{
    const{ev,totalChance}=calcEV(c);
    const costGbp=rate>0?c.cost*rate:c.cost;
    const roi=costGbp>0?(ev-costGbp)/costGbp*100:null;
    const breakEvenChance=rate>0?c.items.reduce((a,item)=>a+(item.value>=costGbp?item.chance:0),0):null;
    return{c,ev,roi,totalChance,costGbp,breakEvenChance};
  }).sort((a,b)=>(b.roi??-Infinity)-(a.roi??-Infinity));

  const maxROI=Math.max(...results.map(r=>Math.abs(r.roi??0)),1);

  const cards=results.map((r,i)=>{
    const rankBadge=i===0?`<span class="rank-badge rank-1"><i class="ti ti-trophy" style="font-size:10px"></i> Best</span>`
      :i===1?`<span class="rank-badge rank-2">2nd</span>`
      :i===2?`<span class="rank-badge rank-3">3rd</span>`:'';
    const roiColor=r.roi==null?'var(--muted)':r.roi>=0?'var(--green)':'var(--red)';
    const roiText=r.roi==null?'N/A':`${r.roi>=0?'+':''}${r.roi.toFixed(1)}%`;
    const warnIcon=r.totalChance>100?` <i class="ti ti-alert-triangle" style="color:var(--amber);font-size:18px" title="Item chances exceed 100% — results may be inflated"></i>`:'';
    const breakEvenText=r.breakEvenChance!=null?`<div class="metric-sub" style="margin-top:3px">Break-even: ${r.breakEvenChance.toFixed(1)}% chance</div>`:'';
    return `<div class="metric-card">
      ${rankBadge}
      <div class="metric-label">${esc(r.c.name)}</div>
      <div class="metric-value" style="color:${roiColor}">${roiText}${warnIcon}</div>
      <div class="metric-sub">EV: £${r.ev.toFixed(2)} &nbsp;·&nbsp; Cost: ${rate>0?`£${r.costGbp.toFixed(2)}`:`<i class="ti ti-coin" style="color:var(--amber);font-size:11px"></i> ${r.c.cost} pts`}</div>
      ${breakEvenText}
      <button class="copy-btn" onclick="copyResult('${esc(r.c.name)}','${roiText}','${r.ev.toFixed(2)}')" title="Copy"><i class="ti ti-copy"></i></button>
    </div>`;
  }).join('');

  const bars=results.map((r)=>{
    const pct=r.roi!=null?Math.min(Math.abs(r.roi)/maxROI*100,100):0;
    const fillColor=r.roi==null?'var(--muted)':r.roi>=0?'#16a34a':'#dc2626';
    const fillBg=r.roi==null?'var(--surface2)':r.roi>=0?'#dcfce7':'#fee2e2';
    const roiLabel=r.roi==null?'No cost set':`${r.roi>=0?'+':''}${r.roi.toFixed(2)}% ROI`;
    const warnIconBar=r.totalChance>100?` <i class="ti ti-alert-triangle" style="color:var(--amber);font-size:12px" title="Item chances exceed 100%"></i>`:'';
    return `<div class="roi-bar-wrap">
      <div class="roi-bar-label">
        <span>${esc(r.c.name)}</span>
        <span style="color:${fillColor}">${roiLabel}${warnIconBar}</span>
      </div>
      <div class="roi-bar-track">
        <div class="roi-bar-fill" style="width:${pct.toFixed(1)}%;background:${fillBg};color:${fillColor}">
          £${r.ev.toFixed(2)} vs ${rate>0?`£${r.costGbp.toFixed(2)}`:`${r.c.cost} pts`}
        </div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML=`<div class="results-grid">${cards}</div><div style="margin-top:1rem">${bars}</div>
  <p class="note"><i class="ti ti-info-circle"></i> ROI = (expected value − cost) ÷ cost × 100. ${rate>0?'Cost is converted to £ using your coin rate.':'Set a coin conversion rate above to compare in £.'} A positive ROI means the crate is worth opening on average.</p>`;
}

function render(){renderCrates();renderResults();updateAllCostDisplays();}

function esc(s){if(s==null)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function showToast(msg, isError=false, action=null){
  const t=document.getElementById('toast');
  const actionHtml=(action&&typeof window[action.fn]==='function')?` <button onclick="${action.fn}()" style="margin-left:8px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px;font-family:inherit;color:#fff">${action.label}</button>`:'';
  t.innerHTML=`<i class="ti ${isError?'ti-alert-circle':'ti-circle-check'}"></i>${msg}${actionHtml}`;
  t.className='toast'+(isError?' is-error':'')+' show';
  t.style.pointerEvents=action?'auto':'none';
  clearTimeout(t._t);
  t._t=setTimeout(()=>{t.className='toast'+(isError?' is-error':'');t.style.pointerEvents='none';},2800);
}

function toggleDarkMode(){
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? '' : 'dark';
  document.getElementById('theme-btn').innerHTML = dark ? '<i class="ti ti-moon"></i>' : '<i class="ti ti-sun"></i>';
  localStorage.setItem('loot_crate_theme', dark ? 'light' : 'dark');
}

function copyResult(name, roi, ev){ navigator.clipboard.writeText(`${name}: ROI ${roi}, EV £${ev}`).then(()=>showToast('Copied to clipboard')).catch(()=>showToast('Copy failed — clipboard access denied',true)); }

function relativeTime(d){ if(!d) return ''; const m=Math.floor((Date.now()-d)/60000); return m<1?' · Saved just now':` · Saved ${m}m ago`; }

function exportData(){
  const json=JSON.stringify(data,null,2);
  const a=Object.assign(document.createElement('a'),{
    href:URL.createObjectURL(new Blob([json],{type:'application/json'})),
    download:'loot-crates.json'
  });
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Exported ${data.crates.length} crate(s)`);
}

function importData(e){
  const file=e.target.files[0];
  e.target.value='';
  if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    try{
      const imported=JSON.parse(ev.target.result);
      if(!imported.crates||!Array.isArray(imported.crates))throw new Error('Missing crates array');
      const valid=imported.crates.every(c=>
        c&&typeof c.id==='string'&&typeof c.name==='string'&&
        typeof c.cost==='number'&&Array.isArray(c.items)&&
        c.items.every(it=>it&&typeof it.id==='string'&&typeof it.name==='string'&&
          typeof it.chance==='number'&&typeof it.value==='number')
      );
      if(!valid)throw new Error('Invalid crate structure');
      const newCrates=imported.crates.map(c=>({
        ...c, id:uid(),
        items:(c.items||[]).map(it=>({...it,id:uid()}))
      }));
      if(data.crates.length>0){
        const replace=confirm(`Import ${newCrates.length} crate(s)?\n\nOK → replace your ${data.crates.length} existing crate(s)\nCancel → add alongside existing crates`);
        data.crates=replace?newCrates:[...data.crates,...newCrates];
      } else {
        data.crates=newCrates;
      }
      save();render();
      showToast(`Imported ${newCrates.length} crate(s)`);
    }catch{
      showToast('Could not read file — make sure it\'s a valid export',true);
    }
  };
  reader.readAsText(file);
}

/* ── Patch notes modal ── */
let patchNotesCache = null;

async function openPatchNotesModal(){
  document.getElementById('patchnotes-modal').style.display='flex';
  if(patchNotesCache){
    document.getElementById('patchnotes-content').textContent=patchNotesCache;
    return;
  }
  try{
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),10000);
    const res=await fetch('./PATCHNOTES.txt',{signal:ctrl.signal}).finally(()=>clearTimeout(timer));
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    patchNotesCache=await res.text();
    document.getElementById('patchnotes-content').textContent=patchNotesCache;
  }catch(e){
    document.getElementById('patchnotes-content').textContent=`Could not load patch notes (${e.name==='AbortError'?'Request timed out':e.message})`;
  }
}
function closePatchNotesModal(){ document.getElementById('patchnotes-modal').style.display='none'; }
function handlePatchNotesOverlayClick(e){ if(e.target===e.currentTarget) closePatchNotesModal(); }

loadBinConfig();
load();render();
(()=>{
  const t=localStorage.getItem('loot_crate_theme')||'dark';
  document.documentElement.dataset.theme=t;
  const b=document.getElementById('theme-btn');
  if(b) b.innerHTML=t==='dark'?'<i class="ti ti-sun"></i>':'<i class="ti ti-moon"></i>';
})();
const _statusInterval=setInterval(()=>{
  if(document.hidden) return;
  const bin=getActiveBin();
  if(bin&&document.getElementById('bin-status').classList.contains('visible')){
    const t=document.getElementById('bin-status-text');
    if(t) t.textContent=`Connected to ${bin.name}${relativeTime(lastSaved)}`;
  }
}, 30000);
window.addEventListener('beforeunload',()=>clearInterval(_statusInterval));
/* Auto-connect to active bin on page load */
(async()=>{
  const bin=getActiveBin();
  if(!bin) return;
  setBinStatus('saving');
  try{
    const record=await fetchBin(bin);
    if(record&&Array.isArray(record.crates)){
      data=record;
      save();render();
    }
    setBinStatus('connected',bin.name);
  }catch(e){
    setBinStatus('error',`Could not load bin (${e.message})`);
  }
})();
