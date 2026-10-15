/* Offline, deterministic Command Anatomy interface. No CDN, remote code, or execution. */
(function(root){
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = {task:null, data:null, progress:null, selected:'', mode:'', host:'', capstoneHost:'',
    placed:[], feedback:null, hints:[], retryFeedback:null, capstoneFeedback:null, capstoneHints:[],
    comparisons:{}, revealCommand:false, revealCapstone:false, error:null,
    hintsComplete:false, capstoneHintsComplete:false, identityWarning:'',storageWarning:''};
  const hosts = ['workstation','servera','serverb'];
  const modeFor = guidance => guidance==='independent'?'type':guidance==='supported'?'blanks':'tokens';
  const guidanceLabel = value => value==='independent'?'Independent mastery':value==='supported'?'Supported practice':'Guided learning';
  const outcomeLabel = value => ({correct:'Correct',correct_alternative:'Correct with supported alternative syntax',
    syntax_error:'Syntax error',semantically_incorrect:'Semantically incorrect',
    missing_required_operation:'Missing required operation',dependency_error:'Dependency or sequencing error',
    persistence_error:'Persistence-related error',unsupported:'Unable to verify this command variation.'}[value]||'Unable to verify this command variation.');
  let memoryLearner = '';
  const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validUuid = value => typeof value==='string'&&UUID_RE.test(value);
  function createUuid(){
    if(root.crypto&&typeof root.crypto.randomUUID==='function') return root.crypto.randomUUID().toLowerCase();
    if(root.crypto&&typeof root.crypto.getRandomValues==='function'){
      const bytes=new Uint8Array(16);root.crypto.getRandomValues(bytes);
      bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
      const hex=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
      const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);
    });
  }
  const getLearnerId = () => {
    const key='lml-command-anatomy-learner-v1';
    try{
      let value=localStorage.getItem(key);
      if(!validUuid(value)){
        value=createUuid();
        if(!validUuid(value)) throw new Error('Could not create a valid learner ID.');
        localStorage.setItem(key,value);
      }
      memoryLearner=value.toLowerCase();
      state.identityWarning='';
      return memoryLearner;
    }catch(e){
      if(!validUuid(memoryLearner)) memoryLearner=createUuid();
      state.identityWarning='This browser is blocking local storage. Your learner identity and drafts may not survive a reload.';
      return memoryLearner;
    }
  };
  const headers = () => ({'Content-Type':'application/json','X-LML-Learner':getLearnerId()});
  const storageKey = (tid,id,mode) => `lml-ca-draft-v1:${tid}:${id}:${mode}`;
  function storageUnavailable(){state.storageWarning='This browser could not save your latest practice draft or selection. Check available site storage and try again.';}
  function saveDraft(id, mode, value){
    try { localStorage.setItem(storageKey(state.task,id,mode), value); } catch(e) { storageUnavailable(); }
  }
  function getDraft(id, mode){
    try { return localStorage.getItem(storageKey(state.task,id,mode))||''; } catch(e) { storageUnavailable(); return ''; }
  }
  function restorePlaced(command){
    try{
      const saved=JSON.parse(getDraft(command.challenge.id,'tokens')||'[]');
      if(Array.isArray(saved)) state.placed=saved.filter(x=>Number.isInteger(x)&&x>=0&&x<stableBank(command).length);
    }catch(e){}
  }
  function restoreHints(id){
    try{const saved=JSON.parse(getDraft(id,'hint-list')||'[]');return Array.isArray(saved)?saved.filter(x=>typeof x==='string'):[];}
    catch(e){return [];}
  }
  function saveCapstone(value){ try{localStorage.setItem(storageKey(state.task,'capstone','type'),value);}catch(e){storageUnavailable();} }
  function getCapstone(){ return getDraft('capstone','type'); }
  function conceptRecord(conceptId){
    return (state.progress?.concepts||[]).find(x=>x.concept_id===conceptId)||null;
  }
  function parseJsonField(value,label){
    if(typeof value!=='string') return value;
    try{return JSON.parse(value);}catch(_){throw new Error(`${label} contains invalid JSON.`);}
  }
  function asBoolean(value,label){
    if(value===true||value===1||value==='1') return true;
    if(value===false||value===0||value==='0'||value==null) return false;
    throw new Error(`${label} must be a boolean or 0/1 flag.`);
  }
  function asCount(value,label){
    const number=Number(value);
    if(!Number.isFinite(number)||number<0) throw new Error(`${label} must be a non-negative number.`);
    return number;
  }
  function normalizeProgress(input){
    const progress=parseJsonField(input,'Progress response');
    if(!progress||typeof progress!=='object'||Array.isArray(progress)) throw new Error('Progress response must be an object.');
    const concepts=parseJsonField(progress.concepts??[],'Progress concepts');
    if(!Array.isArray(concepts)) throw new Error('Progress concepts must be an array.');
    const boolFields=['independent_success','hinted_success','comparison_correct','retention_success','capstone_success','capstone_independent_success'];
    const countFields=['attempts','successes','hint_count','hint_cursor','attempt_hints','variation_successes'];
    const normalizedConcepts=concepts.map((raw,index)=>{
      const item=parseJsonField(raw,`Progress concept ${index+1}`);
      if(!item||typeof item!=='object'||Array.isArray(item)) throw new Error(`Progress concept ${index+1} must be an object.`);
      const result={...item};
      result.misconception_counts=parseJsonField(item.misconception_counts??{},`Progress concept ${index+1} misconception_counts`);
      if(!result.misconception_counts||typeof result.misconception_counts!=='object'||Array.isArray(result.misconception_counts))
        throw new Error(`Progress concept ${index+1} misconception_counts must be an object.`);
      for(const field of boolFields) if(field in result) result[field]=asBoolean(result[field],field);
      for(const field of countFields) if(field in result) result[field]=asCount(result[field],field);
      return result;
    });
    const result={...progress,concepts:normalizedConcepts};
    for(const field of [...boolFields,'manual_override','comparison_evidence','capstone_evidence','capstone_independent_evidence','durable_mastery','grading_independent'])
      if(field in result) result[field]=asBoolean(result[field],field);
    for(const field of ['independent_challenges','independent_evidence','required_independent_evidence','successful_variations'])
      if(field in result) result[field]=asCount(result[field],field);
    if(result.guidance!=null&&!['guided','supported','independent'].includes(result.guidance)) throw new Error('Progress guidance is not recognized.');
    if(result.recommended_guidance!=null&&!['guided','supported','independent'].includes(result.recommended_guidance)) throw new Error('Recommended guidance is not recognized.');
    return result;
  }
  function normalizeContent(input,expectedTask){
    const data=parseJsonField(input,'Command Anatomy response');
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('Command Anatomy response must be an object.');
    if(typeof data.id!=='string'||(expectedTask&&data.id!==expectedTask)) throw new Error('Command Anatomy response has the wrong task ID.');
    for(const field of ['commands','comparisons','deeper_why','troubleshooting','retry_variations'])
      if(!Array.isArray(data[field])) throw new Error(`Command Anatomy ${field} must be an array.`);
    if(!data.capstone||typeof data.capstone!=='object'||!Array.isArray(data.capstone.hints)||!Array.isArray(data.capstone.reference_solution))
      throw new Error('Command Anatomy capstone data is incomplete.');
    for(const command of data.commands){
      if(!command||typeof command.id!=='string'||!command.challenge||!Array.isArray(command.challenge.hints)||!Array.isArray(command.challenge.segments))
        throw new Error('A command challenge is incomplete.');
    }
    return data;
  }
  function hintCount(record){ return Number(record?.hint_count||0); }
  function setProgress(progress){
    state.progress=normalizeProgress(progress);
    if(state.progress.task&&state.task&&state.progress.task!==state.task) throw new Error('Progress response belongs to a different task.');
    if(root.persistAnatomyProgress) root.persistAnatomyProgress(state.progress);
  }
  function evidenceText(record){
    if(!record) return 'Not practiced';
    if(record.independent_success) return 'Independent success recorded';
    if(record.successes) return 'Solved with guidance';
    if(record.attempts) return `${record.attempts} attempt${record.attempts===1?'':'s'}`;
    return 'Not practiced';
  }
  function status(record){
    const t=record&&record.independent_success?'✓ ':record&&record.successes?'◐ ':'○ ';
    return t+evidenceText(record);
  }
  function feedbackHtml(result){
    if(!result) return '';
    const ok=['correct','correct_alternative'].includes(result.outcome);
    let html=`<div class="ca-feedback ${ok?'is-correct':'is-error'}" role="status" aria-live="polite"><b>${ok?'✓':'!'} ${esc(outcomeLabel(result.outcome))}</b><p>${esc(result.message||'')}</p></div>`;
    const m=result.micro_lesson;
    if(m) html+=`<article class="ca-micro"><h4>Focused concept: ${esc(m.id||result.misconception)}</h4>
      <p><b>What the command shows:</b> ${esc(m.observable||'')}</p><p><b>Concept:</b> ${esc(m.explanation||'')}</p>
      <details><summary>30–60 second explanation</summary><p>${esc(m.micro||'')}</p>
      <p><b>Correct example:</b> <code>${esc(m.correct_example||'')}</code></p>
      <p><b>Contrast:</b> <code>${esc(m.contrast||'')}</code></p>
      <p><b>Practical consequence:</b> ${esc(m.consequence||'')}</p>
      <p><b>New retry:</b> ${esc(m.retry||'')}</p><p><b>Man page:</b> ${esc(m.man||'')}</p></details></article>`;
    if(m?.retry_command){
      const retryKey=`retry:${m.id}`;
      const retryFeedback=state.retryFeedback?.id===m.id?state.retryFeedback.result:null;
      const saved=getDraft(retryKey,'type');
      html+=`<section class="ca-retry" aria-label="Fresh retry variation"><h4>Try a fresh variation</h4>
        <p>${esc(m.retry||'Apply this idea to a new example.')}</p>
        ${m.id==='TARGET_HOST'?hostSelect(getRetryHost(m.id), 'ca-retry-host', `retry-host:${m.id}`):''}
        <label class="ca-input-label" for="ca-retry-${esc(m.id)}">Write the command</label>
        <textarea id="ca-retry-${esc(m.id)}" class="ca-answer" data-ca-retry="${esc(m.id)}" rows="2" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Try it without copying the example">${esc(saved)}</textarea>
        <button type="button" class="btn-ghost" data-ca-retry-check="${esc(m.id)}">Check retry</button>
        ${retryFeedback?`<div class="ca-feedback ${retryFeedback.outcome==='correct'?'is-correct':'is-error'}" role="status" aria-live="polite"><b>${esc(outcomeLabel(retryFeedback.outcome))}</b><p>${esc(retryFeedback.message||'')}</p></div>`:''}</section>`;
    }
    if(result.missing?.length) html+=`<p class="ca-note">Still needed: ${esc(result.missing.join(', '))}</p>`;
    return html;
  }
  function partHtml(part,index){
    return `<details class="ca-part"><summary><code>${esc(part.token)}</code></summary><div class="ca-part-body">
      <p><b>Meaning:</b> ${esc(part.meaning)}</p><p><b>Why it matters:</b> ${esc(part.effect)}</p>
      <p><b>If omitted:</b> ${esc(part.without)}</p><p><b>Caution:</b> ${esc(part.danger)}</p></div></details>`;
  }
  function distractors(command){
    const seen=new Set(command.challenge.segments.map(x=>x.value));
    const replacements={'-g':'-G','-G':'-g','-M':'-m','-m':'-M','-a':'-i','+ipv4.addresses':'ipv4.addresses',
      'ipv4.addresses':'+ipv4.addresses','>':'>>','>>':'>','1>':'2>','2>':'1>','-c':'-x','-x':'-c','-p':'-s','-s':'-p'};
    const out=[];
    command.challenge.segments.forEach((segment,index)=>{
      const replacement=replacements[segment.value];
      if(replacement&&!seen.has(replacement)&&!out.some(x=>x.value===replacement))
        out.push({value:replacement,join:segment.join||' ',source:index,distractor:true});
    });
    return out;
  }
  function stableBank(command){
    const target=command.challenge.segments.map((s,index)=>({...s,source:index,distractor:false}));
    const all=target.concat(distractors(command));
    const seed=command.id.split('').reduce((n,c)=>n+c.charCodeAt(0),0);
    return all.map((x,i)=>({x,sort:((i+1)*37+seed*19)%101})).sort((a,b)=>a.sort-b.sort).map(x=>x.x);
  }
  function assembled(command){
    const bank=stableBank(command);
    return state.placed.map((idx,n)=>{
      const item=bank[idx]; return (n===0?'':(item.join||' '))+item.value;
    }).join('');
  }
  function blankIndices(command){
    const segs=command.challenge.segments;
    const scored=[];
    segs.forEach((s,i)=>{
      if(i===0||s.value.includes("<<'EOF'")) return;
      let score=0;
      if(/^[-+]/.test(s.value)) score+=5;
      if(/[=/]|\d/.test(s.value)) score+=3;
      if(i>1) score++;
      if(score) scored.push([score,i]);
    });
    return scored.sort((a,b)=>b[0]-a[0]||a[1]-b[1]).slice(0,3).map(x=>x[1]).sort((a,b)=>a-b);
  }
  function blankAnswer(command){
    const segs=command.challenge.segments, indices=blankIndices(command);
    return segs.map((s,i)=>{
      if(!indices.includes(i)) return (i===0?'':s.join||' ')+s.value;
      const input=document.querySelector(`[data-ca-blank="${i}"]`);
      return (i===0?'':s.join||' ')+(input?input.value:'');
    }).join('');
  }
  function selectedCommand(){ return state.data?.commands.find(c=>c.id===state.selected)||state.data?.commands[0]||null; }
  function getRetryHost(misconceptionId){
    try{return localStorage.getItem(storageKey(state.task,`retry-host:${misconceptionId}`,'select'))||'';}catch(_){storageUnavailable();return '';}
  }
  function hostSelect(value, id, key=''){
    return `<label class="ca-host-select" for="${id}">Command host<select id="${id}" data-ca-host ${key?`data-ca-host-key="${esc(key)}"`:''}><option value="">Choose a host</option>${hosts.map(h=>`<option value="${h}" ${value===h?'selected':''}>${h}</option>`).join('')}</select></label>`;
  }
  function modeButtons(){
    return `<div class="ca-mode-row" role="group" aria-label="Command practice level">${[
      ['tokens','Build tokens'],['blanks','Fill in blanks'],['type','Type independently']
    ].map(([v,label])=>`<button type="button" class="ca-mode ${state.mode===v?'active':''}" data-ca-mode="${v}" aria-pressed="${state.mode===v}">${label}</button>`).join('')}</div>`;
  }
  function commandPractice(command){
    const challenge=command.challenge;
    const bank=stableBank(command);
    let answerArea='';
    if(state.mode==='tokens'){
      const text=assembled(command);
      answerArea=`<p>Tap segments in order. Use Undo to remove the last segment; no dragging is required.</p>
        <div class="ca-token-bank">${bank.map((s,i)=>`<button type="button" class="ca-token" data-ca-token="${i}" aria-label="Add command segment ${esc(s.value)}">${esc(s.value)}</button>`).join('')}</div>
        <div class="ca-build-output"><b>Command being built</b><pre>${esc(text||'Tap a segment to begin')}</pre>
        <div class="ca-inline-actions"><button type="button" class="btn-ghost" data-ca-undo>Undo</button><button type="button" class="btn-ghost" data-ca-reset>Reset</button></div></div>`;
    }else if(state.mode==='blanks'){
      const indices=blankIndices(command);
      const built=command.challenge.segments.map((s,i)=>{
        const join=i===0?'':s.join||' ';
        if(!indices.includes(i)) return `${join}<code>${esc(s.value)}</code>`;
        const draft=state.blankDrafts?.[command.id]?.[i]||'';
        return `${join}<input class="ca-blank" data-ca-blank="${i}" aria-label="Fill command segment ${i+1}" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(draft)}">`;
      }).join('');
      answerArea=`<p>Complete the highlighted options or operands. Fixed context remains visible.</p><div class="ca-fill-line">${built}</div>`;
    }else{
      const draft=getDraft(challenge.id,'type');
      answerArea=`<label class="ca-input-label" for="ca-answer">Write the full command for ${esc(challenge.host)}.</label>
        <textarea id="ca-answer" class="ca-answer" data-ca-answer="type" rows="3" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Type the command from memory">${esc(draft)}</textarea>`;
    }
    return `<section class="ca-challenge" aria-labelledby="ca-challenge-title"><div class="ca-kicker">Stage 4 · Build your own command</div><h4 id="ca-challenge-title">Build your own command</h4>
      ${modeButtons()}${hostSelect(state.host, 'ca-command-host','command-host')}${answerArea}
      <div class="ca-inline-actions"><button type="button" class="btn-term" data-ca-check="${esc(command.id)}">Check command</button>
      <button type="button" class="btn-ghost" data-ca-hint="${esc(command.id)}">Hint <span aria-hidden="true">(${hintCount(conceptRecord(challenge.concept_id))} total)</span></button>
      <button type="button" class="btn-ghost" data-ca-independent="${esc(command.id)}">New attempt without hints</button>
      <button type="button" class="btn-ghost" data-ca-reveal="${esc(command.id)}">Reveal solution</button></div>
      ${state.hints.map((h,i)=>`<div class="ca-hint"><b>Hint ${i+1}:</b> ${esc(h)}</div>`).join('')}
      ${state.hintsComplete?'<p class="ca-note" role="status">You have seen all available hints. Reset hints to start the sequence again.</p>':''}
      ${state.hints.length?`<button type="button" class="btn-ghost" data-ca-reset-hints="${esc(command.id)}">Reset hints</button>`:''}
      ${feedbackHtml(state.feedback)}
      ${state.revealCommand?`<div class="ca-reference"><b>Reference solution</b><pre>${esc(challenge.reference)}</pre><button type="button" class="btn-ghost" data-ca-copy="command">Copy command</button></div>`:''}
    </section>`;
  }
  function comparisonHtml(item){
    const result=state.comparisons[item.id];
    return `<article class="ca-compare"><h4>${esc(item.title)}</h4><p>${esc(item.objective)}</p><p class="ca-question"><b>Predict:</b> ${esc(item.question)}</p>
      <div class="ca-compare-options">${item.options.map((option,i)=>`<div class="ca-compare-option"><div class="ca-option-label">Option ${option.label}</div><pre>${esc(option.variant)}</pre>
        <button type="button" class="btn-ghost" data-ca-predict="${esc(item.id)}" data-ca-choice="${i}" ${result?'disabled':''}>I predict ${option.label}</button></div>`).join('')}</div>
      ${result?`<div class="ca-feedback ${result.outcome==='correct'?'is-correct':'is-error'}" role="status" aria-live="polite"><b>Expected: ${item.options[result.correct_index]?.label||'—'}</b><p>${esc(result.explanation||'')}</p><p><b>Verify:</b> ${esc(result.verification||'')}</p></div>`:''}
    </article>`;
  }
  function capstoneHtml(){
    const c=state.data.capstone;
    const capstoneRecord=conceptRecord(c.concept_id);
    const draft=getCapstone();
    const ref=c.reference_solution.map(item=>`<div class="ca-solution-step"><b>${esc(item.id)} · ${esc(item.host)}${item.verification?' · verification':''}</b><pre>${esc(item.command)}</pre></div>`).join('');
    return `<section class="ca-capstone"><h3>Optional full-task challenge</h3><p>${esc(c.prompt)}</p>
      ${hostSelect(state.capstoneHost, 'ca-capstone-host','capstone-host')}
      <label class="ca-input-label" for="ca-capstone-answer">Structured command sequence — one command per line. Multiline heredocs are supported.</label>
      <textarea id="ca-capstone-answer" class="ca-answer" rows="8" data-ca-capstone autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Plan prerequisites, changes, persistence, and checks before typing">${esc(draft)}</textarea>
      <div class="ca-note"><b>Prerequisites:</b> ${esc(c.preconditions)}</div><div class="ca-note"><b>Persistence:</b> ${esc(c.persistence)}</div>
      <div class="ca-inline-actions"><button type="button" class="btn-term" data-ca-capstone-check>Check complete solution</button>
        <button type="button" class="btn-ghost" data-ca-capstone-hint>Hint (${hintCount(capstoneRecord)} total)</button>
        <button type="button" class="btn-ghost" data-ca-capstone-independent>New attempt without hints</button>
        <button type="button" class="btn-ghost" data-ca-capstone-reveal>Reveal reference solution</button></div>
      ${state.capstoneHints.map((h,i)=>`<div class="ca-hint"><b>Hint ${i+1}:</b> ${esc(h)}</div>`).join('')}
      ${state.capstoneHintsComplete?'<p class="ca-note" role="status">You have seen all available capstone hints. Reset hints to start the sequence again.</p>':''}
      ${state.capstoneHints.length?'<button type="button" class="btn-ghost" data-ca-reset-hints="capstone">Reset hints</button>':''}
      ${feedbackHtml(state.capstoneFeedback)}
      ${state.revealCapstone?`<details class="ca-solution" open><summary>Reference sequence and dependencies</summary>${ref}<p><b>Required checks:</b> ${esc(c.verification_ids.join(', '))}</p><p>This is a simulator. It does not execute commands or award lab completion.</p></details>`:''}
    </section>`;
  }
  function render(data, progress){
    data=normalizeContent(data);
    const changedTask=state.task!==data.id;
    if(changedTask){state.selected='';state.mode='';state.host='';state.capstoneHost='';state.placed=[];state.feedback=null;state.hints=[];state.retryFeedback=null;state.capstoneFeedback=null;state.capstoneHints=[];state.comparisons={};state.revealCommand=false;state.revealCapstone=false;state.error=null;state.hintsComplete=false;state.capstoneHintsComplete=false;}
    state.data=data; state.task=data.id; state.progress=normalizeProgress(progress||{concepts:[],recommended_guidance:'guided',guidance:'guided'});
    if(changedTask){
      try{state.host=localStorage.getItem(storageKey(state.task,'command-host','select'))||'';state.capstoneHost=localStorage.getItem(storageKey(state.task,'capstone-host','select'))||'';}catch(e){storageUnavailable();}
    }
    if(!data.commands.some(c=>c.id===state.selected)) state.selected=data.commands[0]?.id||'';
    if(!state.mode) state.mode=modeFor(state.progress.guidance||state.progress.recommended_guidance);
    const command=selectedCommand();
    if(command){restoreBlankDraft(command);restorePlaced(command);state.hints=restoreHints(command.id);}
    state.capstoneHints=restoreHints('capstone');
    const record=command&&conceptRecord(command.challenge.concept_id);
    const deeper=data.deeper_why.map(x=>`<details class="ca-deeper"><summary>${esc(x.title)}</summary><p>${esc(x.explanation)}</p></details>`).join('');
    const index=data.commands.map(c=>{
      const r=conceptRecord(c.challenge.concept_id);
      return `<div class="ca-index-item"><button type="button" class="ca-command-index ${c.id===state.selected?'selected':''}" data-ca-select="${esc(c.id)}" aria-pressed="${c.id===state.selected}">
        <b>${esc(c.id.toUpperCase())}</b><span class="ca-index-main"><span>${esc(c.purpose)}</span><small>${esc(c.host)} · ${esc(status(r))}</small></span><span aria-hidden="true">›</span></button>
        <details class="ca-index-preview"><summary>Command preview</summary><pre>${esc(c.command)}</pre></details></div>`;
    }).join('');
    let selected='';
    if(command){
      const verification=command.verification?`<div class="ca-note"><b>Verification command:</b><pre>${esc(command.verification)}</pre><p><b>What it checks:</b> ${esc(command.verification_purpose||'')}</p><p><b>Successful result:</b> ${esc(command.verification_success||'')}</p><p><b>Failure may look like:</b> ${esc(command.verification_failure||'')}</p></div>`:
        `<div class="ca-note">Choose the check command shown in this task’s <button type="button" class="ca-link" data-ca-research>Find It Yourself</button> section. Avoid inventing success output.</div>`;
      selected=`<article class="ca-command-detail"><h3>${esc(command.id.toUpperCase())} · Command explorer</h3>
        <p><b>Host:</b> ${esc(command.host)}</p><p><b>Purpose:</b> ${esc(command.purpose)}</p>
        <p class="ca-learning-status">Learning evidence: ${esc(status(record))}</p>
        <details class="ca-reference-collapsed"><summary>Reveal command syntax</summary><pre>${esc(command.command)}</pre></details>
        <details class="ca-anatomy-breakdown"><summary>Explore command segments and expandable explanations</summary><div class="ca-parts">${command.parts.map(partHtml).join('')}</div></details>
        ${verification}<p><b>Man page:</b> <code>man ${esc(command.man_page||'command')}</code>. <button type="button" class="ca-link" data-ca-research>Open contextual man-page research</button></p>
        ${commandPractice(command)}</article>`;
    }
    const guideline=state.progress.guidance||state.progress.recommended_guidance||'guided';
    const warnings=[state.identityWarning,state.storageWarning].filter(Boolean).join(' ');
    const warning=warnings?`<div class="ca-note" role="status">${esc(warnings)}</div>`:'';
    const error=state.error?`<div class="ca-feedback is-error" role="alert"><b>Command Anatomy request failed</b><p>${esc(state.error)}</p></div>`:'';
    return `<div class="ca-engine">${warning}${error}
      <section class="ca-why"><div class="ca-kicker">Stage 1 · Why this command?</div><h2>${esc(data.id)} command anatomy</h2>
        <p>${esc(data.why)}</p><details><summary>Explore deeper concepts</summary>${deeper}</details>
      </section>
      <section class="ca-guidance"><div><b>Recommended guidance:</b> ${esc(guidanceLabel(state.progress.recommended_guidance||'guided'))}
        <p>Progression uses distinct command challenges, independent typing, a comparison, and a capstone. Repeating one answer cannot promote mastery.</p></div>
        <div class="ca-guidance-buttons" role="group" aria-label="Manual guidance override">${['guided','supported','independent'].map(g=>`<button type="button" class="btn-ghost ${guideline===g?'selected':''}" data-ca-guidance="${g}" aria-pressed="${guideline===g}">${esc(guidanceLabel(g))}</button>`).join('')}
        <button type="button" class="btn-ghost" data-ca-guidance="auto">Use recommendation</button></div>
      </section>
      <section class="ca-command-list"><div class="ca-kicker">Stage 2 · Explore command anatomy</div><h3>Choose one command</h3>${index}</section>
      ${selected||(!data.commands.length?'<p class="ca-note" role="status">No command challenges are available for this task yet.</p>':'')}
      <section class="ca-comparisons"><div class="ca-kicker">Stage 3 · Predict before reveal</div><h3>Interactive comparisons</h3>${data.comparisons.map(comparisonHtml).join('')}</section>
      <section class="ca-troubleshoot"><div class="ca-kicker">Stage 5 · Troubleshoot</div><h3>Diagnose real failures</h3>${data.troubleshooting.map(x=>`<details class="ca-trouble"><summary>${esc(x.symptom)}</summary><p><b>Likely cause:</b> ${esc(x.cause)}</p><p><b>Next check or fix:</b> ${esc(x.fix)}</p></details>`).join('')}
        <h4>Apply the idea in a new scenario</h4>${(data.retry_variations||[]).map(item=>`<details class="ca-trouble ca-transfer"><summary>${esc(item.prompt)}</summary><p><b>Success looks like:</b> ${esc(item.success)}</p><p>Work this variation in the lab or on a disposable fixture. This prompt does not execute commands or change grading.</p></details>`).join('')}</section>
      <section class="ca-research"><div class="ca-kicker">Stage 6 · Verify and research</div><h3>Use the existing man-page research path</h3>
        <p>${esc(data.research.intro)}</p>${data.research.steps.map((s,i)=>`<div class="ca-research-step"><b>${i+1}. Open</b> <code>${esc(s.command)}</code><p><b>Search:</b> ${esc(s.search)}</p><p>${esc(s.clue)}</p></div>`).join('')}
        <button type="button" class="btn-ghost" data-ca-research>Open Find It Yourself tab</button></section>
      ${capstoneHtml()}
      <p class="ca-separation">Practice evidence is stored separately from VM grading. Only the existing Check Work grader can mark the RHCSA task as passed.</p>
    </div>`;
  }
  async function post(path,body){
    if(!state.task) throw new Error('Choose a task before sending a Command Anatomy request.');
    let response;
    try{response=await fetch(`/api/tasks/${encodeURIComponent(state.task)}/anatomy/${path}`,{method:'POST',headers:headers(),body:JSON.stringify(body)});}
    catch(error){throw new Error(`Network error: ${error?.message||'could not reach the lab portal.'}`);}
    let bodyText='';
    try{bodyText=await response.text();}catch(error){throw new Error(`Could not read the server response: ${error?.message||'response body unavailable.'}`);}
    let payload;
    try{payload=JSON.parse(bodyText);}catch(_){
      const detail=bodyText.trim().slice(0,240);
      throw new Error(`The portal returned malformed JSON${response.ok?'':` (HTTP ${response.status})`}.${detail?` Response: ${detail}`:''}`);
    }
    if(typeof payload==='string') payload=parseJsonField(payload,`${path} response`);
    if(!response.ok){const detail=payload&&typeof payload==='object'?(payload.error||payload.message):'';throw new Error(`Request failed (HTTP ${response.status})${detail?`: ${detail}`:''}`);}
    if(!payload||typeof payload!=='object'||Array.isArray(payload)) throw new Error(`${path} response must be an object.`);
    if(path==='progress'){
      const progress=normalizeProgress(payload);
      if(progress.task!==state.task) throw new Error('Progress response is missing the requested task ID.');
      return progress;
    }
    if(path==='hint'){
      if(body.reset===true){if(payload.reset!==true) throw new Error('The portal did not confirm the hint reset.');}
      else if(typeof payload.hint!=='string'||!Number.isInteger(Number(payload.index))||typeof payload.complete!=='boolean')
        throw new Error('The portal returned an incomplete hint response.');
    }else if(typeof payload.outcome!=='string'||!['correct','correct_alternative','syntax_error','semantically_incorrect','missing_required_operation','dependency_error','persistence_error','unsupported'].includes(payload.outcome)) throw new Error(`${path} response is missing a recognized outcome.`);
    if(path==='predict'&&(!Number.isInteger(Number(payload.correct_index))||typeof payload.explanation!=='string'))
      throw new Error('Comparison response is missing its expected choice or feedback.');
    if((path==='check'||path==='retry')&&typeof payload.message!=='string') throw new Error(`${path} response is missing feedback.`);
    if(!('progress' in payload)) throw new Error(`${path} response is missing learner progress.`);
    const progress=normalizeProgress(payload.progress);
    if(progress.task!==state.task) throw new Error('Progress response is missing the requested task ID.');
    return {...payload,progress};
  }
  function refresh(){ if(root.renderAnatomyTab) root.renderAnatomyTab(); }
  function message(error){ state.error=error instanceof Error?error.message:String(error||'Unknown error.'); refresh(); }
  async function loadHints(id){
    try{
      const result=await post('hint',{command_id:id});
      const authored=id==='capstone'?state.data.capstone.hints:state.data.commands.find(x=>x.id===id)?.challenge.hints||[];
      if(id==='capstone'){
        while(state.capstoneHints.length<result.index) state.capstoneHints.push(authored[state.capstoneHints.length]||'');
        state.capstoneHints[result.index]=result.hint;
        state.capstoneHintsComplete=result.complete;
        saveDraft('capstone','hint-list',JSON.stringify(state.capstoneHints));
      }else{
        while(state.hints.length<result.index) state.hints.push(authored[state.hints.length]||'');
        state.hints[result.index]=result.hint;
        state.hintsComplete=result.complete;
        saveDraft(id,'hint-list',JSON.stringify(state.hints));
      }
      setProgress(result.progress); state.error=null; refresh();
    }catch(e){ message(e); }
  }
  async function resetHints(id){
    try{
      const result=await post('hint',{command_id:id,reset:true});
      if(id==='capstone'){state.capstoneHints=[];state.capstoneHintsComplete=false;saveDraft('capstone','hint-list','[]');}
      else{state.hints=[];state.hintsComplete=false;saveDraft(id,'hint-list','[]');}
      setProgress(result.progress);state.error=null;refresh();
    }catch(e){message(e);}
  }
  async function beginIndependent(id){
    try{
      const result=await post('hint',{command_id:id,reset:true});
      if(id==='capstone'){
        state.capstoneHints=[]; state.capstoneHintsComplete=false; state.capstoneFeedback=null;
        saveDraft('capstone','hint-list','[]');
      }else{
        state.hints=[]; state.hintsComplete=false; state.feedback=null; state.mode='type';
        saveDraft(id,'hint-list','[]');
      }
      setProgress(result.progress); state.error=null; refresh();
    }catch(e){ message(e); }
  }
  function getAnswer(command){
    if(state.mode==='tokens') return assembled(command);
    if(state.mode==='blanks') return blankAnswer(command);
    return document.querySelector('[data-ca-answer="type"]')?.value||getDraft(command.challenge.id,'type');
  }
  async function checkCommand(id){
    const command=state.data.commands.find(c=>c.id===id); if(!command){message(`Unknown command challenge: ${id}`);return;}
    const answer=getAnswer(command), host=document.querySelector('[data-ca-host]')?.value||'';
    if(state.mode!=='blanks') saveDraft(command.challenge.id,state.mode,answer);
    try{
      state.feedback=await post('check',{command_id:id,answer,host,mode:state.mode,hints_used:state.hints.length});
      state.retryFeedback=null;
      setProgress(state.feedback.progress);
      state.error=null;
      if(!['correct','correct_alternative'].includes(state.feedback.outcome)&&!state.progress.manual_override){
        const record=conceptRecord(command.challenge.concept_id);
        state.mode=record&&record.attempts>=2?'tokens':(state.mode==='type'?'blanks':state.mode);
      }
      refresh();
    }catch(e){ message(e); }
  }
  async function predict(id,index){
    try{ state.comparisons[id]=await post('predict',{comparison_id:id,selected_index:index});
      setProgress(state.comparisons[id].progress); state.error=null; refresh(); }
    catch(e){ message(e); }
  }
  async function checkCapstone(){
    const answer=document.querySelector('[data-ca-capstone]')?.value||getCapstone();
    const host=document.querySelector('#ca-capstone-host')?.value||''; saveCapstone(answer);
    try{ state.capstoneFeedback=await post('check',{command_id:'capstone',answer,host,mode:'type',hints_used:state.capstoneHints.length});
      setProgress(state.capstoneFeedback.progress); state.error=null; refresh(); }
    catch(e){ message(e); }
  }
  async function checkRetry(misconceptionId){
    const key=`retry:${misconceptionId}`;
    const input=Array.from(document.querySelectorAll('[data-ca-retry]')).find(x=>x.dataset.caRetry===misconceptionId);
    const answer=input?.value||getDraft(key,'type');
    saveDraft(key,'type',answer);
    try{
      const host=misconceptionId==='TARGET_HOST'?document.querySelector('#ca-retry-host')?.value||'':'';
      const result=await post('retry',{misconception_id:misconceptionId,answer,host});
      state.retryFeedback={id:misconceptionId,result}; setProgress(result.progress); state.error=null;refresh();
    }catch(e){ message(e); }
  }
  async function setGuidance(value){
    try{
      const result=await post('progress',{guidance:value==='auto'?null:value});
      setProgress(result); state.mode=modeFor(result.guidance||result.recommended_guidance);state.error=null;refresh();
    }catch(e){ message(e); }
  }
  function saveTyped(event){
    const el=event.target;
    if(el.matches('[data-ca-answer="type"]')) saveDraft(selectedCommand().challenge.id,'type',el.value);
    if(el.matches('[data-ca-retry]')) saveDraft(`retry:${el.dataset.caRetry}`,'type',el.value);
    if(el.matches('[data-ca-capstone]')) saveCapstone(el.value);
    if(el.matches('[data-ca-blank]')){
      const command=selectedCommand(), values={};
      document.querySelectorAll('[data-ca-blank]').forEach(i=>values[i.dataset.caBlank]=i.value);
      state.blankDrafts=state.blankDrafts||{}; state.blankDrafts[command.id]=values;
      saveDraft(command.challenge.id,'blanks',JSON.stringify(values));
    }
  }
  function saveHost(event){
    if(!event.target.matches('[data-ca-host]')) return;
    const key=event.target.dataset.caHostKey||(event.target.id==='ca-capstone-host'?'capstone-host':'command-host');
    if(key==='capstone-host') state.capstoneHost=event.target.value;
    else if(key==='command-host') state.host=event.target.value;
    try{localStorage.setItem(storageKey(state.task,key,'select'),event.target.value);}catch(e){storageUnavailable();}
  }
  function restoreBlankDraft(command){
    if(state.blankDrafts?.[command.id]) return;
    try{state.blankDrafts=state.blankDrafts||{};state.blankDrafts[command.id]=JSON.parse(getDraft(command.challenge.id,'blanks')||'{}');}catch(e){}
  }
  function click(event){
    const button=event.target.closest('[data-ca-select],[data-ca-mode],[data-ca-token],[data-ca-undo],[data-ca-reset],[data-ca-check],[data-ca-hint],[data-ca-reset-hints],[data-ca-independent],[data-ca-reveal],[data-ca-guidance],[data-ca-predict],[data-ca-capstone-check],[data-ca-capstone-hint],[data-ca-capstone-independent],[data-ca-capstone-reveal],[data-ca-research],[data-ca-copy],[data-ca-retry-check],[data-ca-load-retry]');
    if(!button) return;
    if(button.dataset.caSelect){
      state.selected=button.dataset.caSelect; state.mode=modeFor(state.progress.guidance||state.progress.recommended_guidance||'guided');
      state.placed=[]; state.feedback=null; state.hints=[]; state.revealCommand=false;
      const c=selectedCommand(); if(c) restorePlaced(c); refresh();
    }else if(button.dataset.caMode){state.mode=button.dataset.caMode;state.placed=[];refresh();}
    else if(button.hasAttribute('data-ca-token')){state.placed.push(Number(button.dataset.caToken));saveDraft(selectedCommand().challenge.id,'tokens',JSON.stringify(state.placed));refresh();}
    else if(button.hasAttribute('data-ca-undo')){state.placed.pop();saveDraft(selectedCommand().challenge.id,'tokens',JSON.stringify(state.placed));refresh();}
    else if(button.hasAttribute('data-ca-reset')){state.placed=[];saveDraft(selectedCommand().challenge.id,'tokens','[]');state.feedback=null;refresh();}
    else if(button.dataset.caCheck) checkCommand(button.dataset.caCheck);
    else if(button.dataset.caHint) loadHints(button.dataset.caHint);
    else if(button.dataset.caResetHints) resetHints(button.dataset.caResetHints);
    else if(button.hasAttribute('data-ca-load-retry')) root.renderAnatomyTab?.({force:true});
    else if(button.dataset.caIndependent) beginIndependent(button.dataset.caIndependent);
    else if(button.dataset.caReveal){state.revealCommand=true;refresh();}
    else if(button.dataset.caGuidance) setGuidance(button.dataset.caGuidance==='auto'?'auto':button.dataset.caGuidance);
    else if(button.dataset.caPredict) predict(button.dataset.caPredict,Number(button.dataset.caChoice));
    else if(button.hasAttribute('data-ca-capstone-check')) checkCapstone();
    else if(button.hasAttribute('data-ca-capstone-hint')) loadHints('capstone');
    else if(button.hasAttribute('data-ca-capstone-independent')) beginIndependent('capstone');
    else if(button.hasAttribute('data-ca-capstone-reveal')){state.revealCapstone=true;refresh();}
    else if(button.dataset.caRetryCheck) checkRetry(button.dataset.caRetryCheck);
    else if(button.hasAttribute('data-ca-research')){
      if(root.openResearchTab) root.openResearchTab();
    }else if(button.hasAttribute('data-ca-copy')){
      const c=selectedCommand();
      if(!c) message('Select a command before copying it.');
      else if(!navigator.clipboard?.writeText) message('Clipboard access is unavailable. Select and copy the command text instead.');
      else navigator.clipboard.writeText(c.command).catch(e=>message(`Could not copy command: ${e?.message||'clipboard access was denied.'}`));
    }
  }
  document.addEventListener('click',click);
  document.addEventListener('input',saveTyped);
  document.addEventListener('change',saveHost);
  function loadingHtml(task){return `<p class="ca-loading" role="status">Loading Command Anatomy for ${esc(task)}…</p>`;}
  function errorHtml(error){return `<div class="ca-load-error" role="alert"><b>Command Anatomy could not load.</b><p>${esc(error||'Unknown error.')}</p><button type="button" class="btn-ghost" data-ca-load-retry>Retry</button></div>`;}
  root.CommandAnatomy={render,headers,learnerId:getLearnerId,validUuid,normalizeProgress,normalizeContent,loadingHtml,errorHtml};
})(typeof globalThis!=='undefined'?globalThis:this);
