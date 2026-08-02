const fs = require('fs');
process.chdir('d:\\Trae Work\\RetroRadioDesktop');
// --- Mocks ---
global.window = { addEventListener: ()=>{}, removeEventListener: ()=>{} };
global.document = { getElementById: ()=>null, querySelectorAll:()=>[], createElement:()=>({classList:{add:()=>{},remove:()=>{}},addEventListener:()=>{}}), querySelector:()=>null };
global.navigator = { userAgent: 'Node' };
global.els = { toast: { classList: {add:()=>{},remove:()=>{}} }, fpStatus:null, appVersionBadge:null, topRegion:null };
global.state = { channels: null, _t:null };
global.showToast = ()=>{};
global.clearTimeout = ()=>{};
global.setTimeout = ()=>1;
global.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
global.HistoryError = Error;
// --- channels.js: "const CHANNEL_DATA = {...}"
//     In Node inside eval(), "const X =" in an eval string does NOT become
//     a property of the caller, only lives inside eval lexical scope. So we
//     must suffix to assign it out. ---
const channelsSrc = fs.readFileSync('mobile/www/channels.js','utf8');
// Replace first const CHANNEL_DATA with global assignment
const channelsReplaced = channelsSrc.replace(
  /^const CHANNEL_DATA =/,
  'global.CHANNEL_DATA ='
);
eval(channelsReplaced);
const dataSet = global.CHANNEL_DATA;
global.window.CHANNEL_DATA = dataSet;
console.log('CHANNEL_DATA.radio len =', dataSet && dataSet.radio ? dataSet.radio.length : 'NULL');
// --- Execute mobile www/app.js (will see global.CHANNEL_DATA) ---
const src = fs.readFileSync('mobile/www/app.js','utf8');
try { eval(src); } catch(e) { console.log('(non-fatal UI eval):', String(e).substring(0,140)); }

// --- Now call processChannels + electronStationSort ---
const processed = processChannels(CHANNEL_DATA);
const gucheng = processed.radio.filter(c => /故城/.test(c.name));
const jjzsArr = processed.radio.filter(c => /经济之声/.test(c.name));
const dszsArr = processed.radio.filter(c => /经典音乐广播/.test(c.name));
const centralRaw = processed.radio.filter(c => c.description === '中央');
const centralSorted = electronStationSort('中央', centralRaw);
console.log('\n==== MOBILE (v70) loadChannels output ====');
console.log('总台数:', processed.radio.length, '/ expected 1652   中央数:', centralSorted.length, '/32   故城县电台数:', gucheng.length);
console.log('');
centralSorted.slice(0,20).forEach((c,i)=>console.log(String(i+1).padStart(2,'0')+'. '+String(c.name||'').padEnd(24)+' URL='+String(c.url||'NULL').substring(0,80)));
console.log('');
jjzsArr.forEach(c => console.log('经济之声实例: name='+c.name+'  URL='+c.url));
dszsArr.forEach(c => console.log('经典音乐广播实例: name='+c.name+'  URL='+c.url));
if (gucheng.length) console.log('故城县:', gucheng.map(c=>c.name+' desc='+c.description).join(' || '));
let cntWs=0,cntHttpN=0,cntHttpS=0,cntSatClean=0;
processed.radio.forEach(s => {
  if (s.url && s.url.includes('satellitepull.cnr.cn') && s.url.includes('wsSession=')) cntWs++;
  else if (s.url && s.url.includes('satellitepull.cnr.cn')) cntSatClean++;
  if (s.url && s.url.startsWith('http://ngcdn')) cntHttpN++;
  if (s.url && s.url.startsWith('https://ngcdn')) cntHttpS++;
});
console.log('');
console.log('satellitepull+wsSession(期望0):', cntWs);
console.log('satellitepull clean:', cntSatClean);
console.log('HTTP ngcdn(期望0):', cntHttpN);
console.log('HTTPS ngcdn(期望>0):', cntHttpS);
