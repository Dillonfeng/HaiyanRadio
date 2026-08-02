// 验证mobile v67的electronStationSort排序结果是否和Electron buildStationTree完全一致
const fs = require('fs');
const appRaw = fs.readFileSync('D:\\Trae Work\\RetroRadioDesktop\\app.js', { encoding: 'utf8' });
const mobileRaw = fs.readFileSync('D:\\Trae Work\\RetroRadioDesktop\\mobile\\www\\app.js', { encoding: 'utf8' });
const channelRaw = fs.readFileSync('D:\\Trae Work\\RetroRadioDesktop\\channels.js', { encoding: 'utf8' });

// 1. loadChannels CHANNEL_DATA
eval(channelRaw.replace(/^const\s+CHANNEL_DATA\s*=\s*/, 'var CHANNEL_DATA = '));
console.log('CHANNEL_DATA.radio.length =', CHANNEL_DATA.radio.length);

// 2. 从Electron提取processChannels
const eLines = appRaw.split(/\r?\n/);
function extractFn(reStart) {
  let s=-1,e=-1,d=0,started=false;
  for (let i = 0; i < eLines.length; i++) {
    if (s===-1 && reStart.test(eLines[i])) { s=i; d=0; started=true; }
    if (started) {
      for (const ch of eLines[i]) { if (ch==='{') d++; else if (ch==='}') d--; }
      if (d===0 && i>s) { e=i; break; }
    }
  }
  return (s===-1||e===-1)?null: eLines.slice(s,e+1).join('\n');
}
const pcStr = extractFn(/^\s*function\s+processChannels\s*\(\s*data\s*\)\s*\{/);
const nsStr = extractFn(/^\s*function\s+normalizeStr\s*\(\s*str\s*\)\s*\{/);
const bsStr = extractFn(/^\s*function\s+buildStationTree\s*\(\s*list\s*\)\s*\{/);
if (!pcStr) { console.log('electron processChannels extract FAIL'); process.exit(1); }
eval(pcStr + '\n' + (nsStr||'') + '\n' + bsStr);

// 3. 从mobile提取electronStationSort（核心排序函数）
const mLines = mobileRaw.split(/\r?\n/);
let ms=-1,me=-1,d=0,started=false;
for (let i = 0; i < mLines.length; i++) {
  if (ms===-1 && /^\s*function\s+electronStationSort\s*\(/.test(mLines[i])) { ms=i; d=0; started=true; }
  if (started) {
    for (const ch of mLines[i]) { if (ch==='{') d++; else if (ch==='}') d--; }
    if (d===0 && i>ms) { me=i; break; }
  }
}
console.log('mobile electronStationSort lines =', ms, '..', me);
if (ms===-1) { console.log('FAIL extract electronStationSort'); process.exit(2); }
// 提取ELECTRON_CITY_ORDER和ELECTRON_PROVINCE_ORDER定义
let cityStart=-1,cityEnd=-1; d=0; started=false;
for (let i = 0; i < mLines.length; i++) {
  if (cityStart===-1 && /^\s*const\s+ELECTRON_CITY_ORDER\s*=\s*\{/.test(mLines[i])) { cityStart=i; d=0; started=true; }
  if (started) {
    for (const ch of mLines[i]) { if (ch==='{') d++; else if (ch==='}') d--; }
    if (d===0 && i>cityStart) { cityEnd=i; break; }
  }
}
let provStart=-1,provEnd=-1;
for (let i = 0; i < mLines.length; i++) {
  if (provStart===-1 && /^\s*const\s+ELECTRON_PROVINCE_ORDER\s*=\s*\[/.test(mLines[i])) { provStart=i; d=0; started=true; }
  if (started) {
    for (const ch of mLines[i]) { if (ch==='[') d++; else if (ch===']') d--; }
    if (d===0 && i>provStart) { provEnd=i; break; }
  }
}
console.log('CITY_ORDER:', cityStart, '..', cityEnd, '  PROVINCE_ORDER:', provStart,'..',provEnd);
eval(
  mLines.slice(cityStart, cityEnd+1).join('\n') + '\n' +
  mLines.slice(provStart, provEnd+1).join('\n') + '\n' +
  mLines.slice(ms, me+1).join('\n')
);
console.log('typeof electronStationSort =', typeof electronStationSort);

// 4. 运行processChannels → 分两组结果对比
const result = processChannels(CHANNEL_DATA);
console.log('\nprocessChannels radio.length =', result.radio.length);
const electronTree = buildStationTree(result.radio);
const electronCentral = electronTree.find(t => t.name==='中央').children.map(c=>c.data.name);
console.log('\n=== Electron buildStationTree 中央 (32条): ===');
electronCentral.forEach((n,i)=>console.log((i+1).toString().padStart(2,' ')+'. '+n));

const mobileCentralRaw = result.radio.filter(c => c.description==='中央');
const mobileCentralSorted = electronStationSort('中央', mobileCentralRaw).map(c=>c.name);
console.log('\n=== Mobile electronStationSort 中央 (32条): ===');
mobileCentralSorted.forEach((n,i)=>console.log((i+1).toString().padStart(2,' ')+'. '+n));

console.log('\n=== 对比两条结果（0 error才算通过）：===');
let miss = 0;
for (let i=0;i<Math.max(electronCentral.length, mobileCentralSorted.length);i++) {
  if (electronCentral[i] !== mobileCentralSorted[i]) {
    console.log('✗', (i+1), 'ELEC="'+electronCentral[i]+'"', 'MOBILE="'+mobileCentralSorted[i]+'"');
    miss++;
  }
}
console.log('\nERROR COUNT =', miss, '（必须=0）');
if (miss===0) console.log('\n🎉 100%完全匹配！mobile的ElectronStationSort算法与Electron buildStationTree完全一致！顺序0误差！');
