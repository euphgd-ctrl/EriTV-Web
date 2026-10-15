/* Local lesson rendering. No fetches, HTML from authors, or external dependencies. */
(function(root){
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text = value => `<div class="txt">${esc(value).replace(/\n/g,'<br>')}</div>`;
  const section = (title, body) => `<section class="sect"><h3>${esc(title)}</h3>${body}</section>`;
  const card = (title, body) => `<article class="lesson-card"><h4>${esc(title)}</h4>${body}</article>`;
  const command = c => `<span class="lesson-host">Run on ${esc(c.host)} as student${c.command.includes('sudo')?' (sudo where shown)':''}</span><code class="cmd">${esc(c.command)}</code>`;
  const chips = (c,ci,flagsOnly=false) => `<div class="lesson-tokens">${c.parts.map((p,pi)=>
    flagsOnly && !p.token.startsWith('-') ? '' : `<button type="button" class="flag-chip" data-lesson-command="${ci}" data-lesson-part="${pi}" aria-haspopup="dialog">${esc(p.token)}</button>`).join('')}</div>`;
  function partBody(p){
    return `<p><b>Meaning:</b> ${esc(p.meaning)}</p><p><b>Effect:</b> ${esc(p.effect)}</p><p><b>Without it:</b> ${esc(p.without)}</p><p><b>Watch out:</b> ${esc(p.danger)}</p>`;
  }
  function render(lesson, tab){
    if(tab==='mission') return section('Why this matters', text(lesson.why));
    if(tab==='deep') return section('Concepts from zero', lesson.concepts.map(x=>card(x.title,text(x.explanation))).join(''));
    if(tab==='anatomy') return section('Every command, switch and operand', text('Options belong to their command. Tap a token for its meaning, mechanical effect, omission behavior and cautions. Expand the complete breakdown to study every part.') + lesson.commands.map((c,ci)=>card(c.id.toUpperCase(), command(c) +
      chips(c,ci)+
      `<details class="lesson-details"><summary>Complete command breakdown</summary>${c.parts.map(p=>card(p.token,partBody(p))).join('')}</details>`)).join(''));
    if(tab==='research') return section('Find it yourself with man pages',
      text(lesson.man_page_research.intro) +
      lesson.man_page_research.steps.map((x,i)=>card('Research step '+(i+1),
        '<p><b>Open:</b></p><code class="cmd">'+esc(x.command)+'</code><p><b>Search inside it:</b> <code>'+esc(x.search)+'</code></p><p><b>What you are trying to learn:</b> '+esc(x.clue)+'</p>')).join('') +
      '<div class="hint">💡 Do the research first. Then write your own command from what the manual says; compare it with Teach Me only after you have attempted it.</div>');
    if(tab==='teach'){
      const byId = new Map(lesson.commands.map(c=>[c.id,c]));
      return section('Guided practice', text('Use Setup lab for this task first. Open the terminal on the host shown for each step; these are commands inside that host, not commands chained after interactive SSH. Replace any explicit placeholder before running. Read the explanation before typing.') + lesson.guided_practice.map((s,i)=>{
        const c=byId.get(s.command_id);
        return card(`Step ${i+1}`,command(c)+chips(c,lesson.commands.indexOf(c),true)+text(s.explanation));
      }).join(''));
    }
    if(tab==='practice') return section('Independent practice', text('These are ungraded transfer exercises. Use disposable scratch paths or a separate VM; do not change the graded fixture’s required values. Try from memory, then compare the success criteria.')+lesson.variations.map(x=>card(x.title,text(x.objective)+`<details class="lesson-details"><summary>Success criteria</summary>${text(x.success)}</details>`)).join(''));
    if(tab==='traps') return section('Exam traps',lesson.exam_traps.map(x=>`<div class="trap">${esc(x)}</div>`).join(''));
    if(tab==='fix') return section('Troubleshooting',lesson.troubleshooting.map(x=>card(x.symptom,`<p><b>Likely cause:</b> ${esc(x.cause)}</p><p><b>Next action:</b> ${esc(x.fix)}</p>`)).join(''));
    if(tab==='check') return section('Self-check: answer cold first',lesson.self_check.map((x,i)=>card(`${i+1}. ${x.question}`,`<details class="lesson-details"><summary>Reveal answer</summary>${text(x.answer)}</details>`)).join(''));
    if(tab==='expert') return section('Going deeper',lesson.deeper.map(x=>card(x.title,text(x.explanation))).join(''));
    return '';
  }
  const api={render,partBody,esc};
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.LessonView=api;
})(typeof globalThis!=='undefined'?globalThis:this);
