// Local visual QA gallery, independent of the database and PandaScore.
// Run: node scripts/preview-brackets.js, then open http://127.0.0.1:4318/preview.
const express = require('express');
const path = require('node:path');
const app = express();
app.use(express.static(path.join(__dirname, '../public')));
app.get('/preview', (req, res) => res.send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>赛程图预览</title><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/bracket.css">
<style>body{margin:0;padding:24px;background:var(--surface-4,#f3f5f8)}main{width:100%;min-width:0;max-width:1120px;margin:auto}h1{font-size:22px;margin:0 0 8px}h2{font-size:14px;margin:28px 0 8px}p{font-size:12px;color:var(--text-secondary)}header{display:flex;align-items:center;justify-content:space-between;gap:16px}header button{width:auto;padding:6px 12px;font-size:12px}body.mobile{padding:10px}.preview-mobile{width:390px;height:650px;border:1px solid #dce3eb;border-radius:12px;background:#fff}html{overflow-x:hidden}</style>
<main><header><h1>赛程图</h1><button id="theme">切换主题</button></header><p>查看轮次，悬停比赛追踪晋级路径，点击“定位当前”查看正在进行的比赛。</p><div id="gallery"></div></main>
<script>function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function logoHtml(){return '<span class="placeholder">◈</span>'}function focusTournamentMatch(){};</script>
<script src="/js/bracket-graph.js"></script><script src="/js/bracket.js"></script><script src="/js/bracket-ui.js"></script>
<script>
const compact=new URLSearchParams(location.search).has('mobile');if(compact)document.body.classList.add('mobile');
document.getElementById('theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'};
let sequence=0;
function fixture(name,status='finished',s1=2,s2=1){let id=++sequence;return{id,name,external_id:'cs2:'+id,stage_external_id:'demo',status,team1_id:id*2,team2_id:id*2+1,team1_name:['Vitality','NAVI','Spirit','MOUZ','Falcons','G2'][id%6],team2_name:['FURIA','Liquid','The MongolZ','FaZe','Aurora'][id%5],team1_score:status==='finished'?s1:null,team2_score:status==='finished'?s2:null,winner_team_id:status==='finished'?(s1>s2?id*2:id*2+1):null,match_time:new Date(Date.now()+id*3600000).toISOString()}}
function edge(from,to,type='winner'){return{source_external_match_id:from.external_id,match_external_id:to.external_id,source_type:type}}
function add(label,matches,edges,has=1){let official={external_id:'demo',name:label,has_bracket:has,nodes:matches.map(m=>({external_match_id:m.external_id,local_match_id:m.id,name:m.name})),edges};let stage=buildTournamentStagesWithOfficial(matches,[official])[0];document.getElementById('gallery').insertAdjacentHTML('beforeend','<h2>'+escapeHtml(label)+'</h2>'+stageDiagram(stage));}
const q1=fixture('Quarterfinal 1'),q2=fixture('Quarterfinal 2'),s=fixture('Semifinal 1','ongoing'),f=fixture('Grand final','upcoming');
add('淘汰赛 · Playoffs',[q1,q2,s,f],[edge(q1,s),edge(q2,s),edge(s,f)]);
const u1=fixture('Upper bracket round 1 match 1'),u2=fixture('Upper bracket round 1 match 2'),uf=fixture('Upper bracket final'),l1=fixture('Lower bracket round 1','ongoing'),lf=fixture('Lower bracket final','upcoming'),gf=fixture('Grand final','upcoming');
add('双败淘汰赛',[u1,u2,uf,l1,lf,gf],[edge(u1,uf),edge(u2,uf),edge(u1,l1,'loser'),edge(u2,l1,'loser'),edge(l1,lf),edge(uf,lf,'loser'),edge(uf,gf),edge(lf,gf)]);
const o1=fixture('Opening 1'),o2=fixture('Opening 2'),w=fixture('Winners match'),e=fixture('Elimination match','ongoing'),d=fixture('Decider match','upcoming');
add('GSL 小组赛',[o1,o2,w,e,d],[edge(o1,w),edge(o2,w),edge(o1,e,'loser'),edge(o2,e,'loser'),edge(w,d,'loser'),edge(e,d)],0);
const swiss=[8,8,8,6,3].flatMap((count,r)=>Array.from({length:count},()=>({...fixture('Round '+(r+1)+': TBD vs TBD','upcoming'),team1_name:'TBD',team2_name:'TBD',stage_name:'Swiss Stage'})));
add('Swiss Stage',swiss,[],0);
if(!compact)document.querySelector('main').insertAdjacentHTML('beforeend','<h2>手机预览 · 390px</h2><iframe class="preview-mobile" title="手机赛程图" src="/preview?mobile=1"></iframe>');
</script></html>`));
app.get('/', (req, res) => res.redirect('/preview'));
app.listen(4318, '127.0.0.1', () => console.log('Bracket preview: http://127.0.0.1:4318/preview'));
