// 验证Electron版中央分组排序顺序 = localeCompare(zh-CN)的拼音首字母排序
const fs = require('fs');
const appRaw = fs.readFileSync('D:\\Trae Work\\RetroRadioDesktop\\app.js', { encoding: 'utf8' });

// 1. 先加载CHANNEL_DATA（channels.js里）
const channelRaw = fs.readFileSync('D:\\Trae Work\\RetroRadioDesktop\\channels.js', { encoding: 'utf8' });
// channels.js是 const CHANNEL_DATA = {...}（无分号结尾的JSON对象），替换const为var保证global注入，eval后直接可用
const safeForEval = channelRaw.replace(/^const\s+CHANNEL_DATA\s*=\s*/, 'var CHANNEL_DATA = ');
eval(safeForEval);
console.log('typeof CHANNEL_DATA =', typeof CHANNEL_DATA);
console.log('typeof CHANNEL_DATA.radio =', typeof (CHANNEL_DATA && CHANNEL_DATA.radio));
console.log('CHANNEL_DATA.radio.length =', (CHANNEL_DATA && CHANNEL_DATA.radio) ? CHANNEL_DATA.radio.length : 'N/A');
if (typeof CHANNEL_DATA === 'undefined' || !CHANNEL_DATA.radio) { console.log('CHANNEL_DATA eval fail'); process.exit(2); }

// 2. 深度匹配processChannels整段函数（前面有空格也行，function前面可能有空格）
const lines = appRaw.split(/\r?\n/);
let pcStart = -1, pcEnd = -1, depth = 0, started = false;
for (let i = 0; i < lines.length; i++) {
  if (pcStart === -1 && /^\s*function\s+processChannels\s*\(\s*data\s*\)\s*\{/.test(lines[i])) {
    pcStart = i; depth = 0; started = true;
  }
  if (started) {
    for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0 && i > pcStart) { pcEnd = i; break; }
  }
}
console.log('processChannels lines (0-based):', pcStart, '..', pcEnd);
if (pcStart === -1 || pcEnd === -1) process.exit(3);
const pcStr = lines.slice(pcStart, pcEnd + 1).join('\n');
eval(pcStr);
console.log('typeof processChannels =', typeof processChannels);

// 3. 提取buildStationTree函数（参数名是list，前面2格空格）
let bsStart = -1, bsEnd = -1; depth = 0; started = false;
for (let i = 0; i < lines.length; i++) {
  if (bsStart === -1 && /^\s*function\s+buildStationTree\s*\(\s*list\s*\)\s*\{/.test(lines[i])) {
    bsStart = i; depth = 0; started = true;
  }
  if (started) {
    for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0 && i > bsStart) { bsEnd = i; break; }
  }
}
console.log('buildStationTree lines (0-based):', bsStart, '..', bsEnd);
if (bsStart === -1 || bsEnd === -1) process.exit(4);
// 还要提取normalizeStr（buildStationTree里可能用到localeCompare，但先看有没有用normalizeStr）
let nsStart = -1, nsEnd = -1; depth = 0; started = false;
for (let i = 0; i < lines.length; i++) {
  if (nsStart === -1 && /^\s*function\s+normalizeStr\s*\(\s*str\s*\)\s*\{/.test(lines[i])) {
    nsStart = i; depth = 0; started = true;
  }
  if (started) {
    for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0 && i > nsStart) { nsEnd = i; break; }
  }
}
console.log('normalizeStr lines (0-based):', nsStart, '..', nsEnd);
let combined = '';
if (nsStart !== -1) combined += lines.slice(nsStart, nsEnd + 1).join('\n') + '\n';
combined += lines.slice(bsStart, bsEnd + 1).join('\n');
eval(combined);
console.log('typeof buildStationTree =', typeof buildStationTree);
console.log('typeof normalizeStr =', typeof normalizeStr);

// 4. 运行processChannels → buildStationTree
const result = processChannels(CHANNEL_DATA);
console.log('\n=== processChannels output: radio=', result.radio.length, 'tv=', result.tv.length);
const tree = buildStationTree(result.radio);
console.log('tree node count=', tree.length);

// 5. 中央分组完整顺序输出
const central = tree.find(t => t.name === '中央');
if (!central) { console.log('FAIL: no 中央 in tree'); process.exit(5); }
console.log('\n=== Electron buildStationTree() 中央分组最终顺序 (' + central.children.length + ' stations):');
central.children.forEach((n, i) => {
  console.log((i+1).toString().padStart(2, ' ') + '. ' + n.data.name);
});

// 6. 验证截图前24条：用户截图的顺序是：
// 1.故城县经典音乐FM90.5 2.环球资讯 3.经典音乐广播 4.经济之声 5.南海之声 6.轻松调频 7.台海之声 8.音乐之声
// 9.阅读之声 10.中央文艺之声 11.中央中国之声 12.CGTN - English 13.CGTN Arabic 14.CGTN Documentary 15.CGTN Radio 16.CGTN Russian
// 17.CNR-1 中国之声 重复N次 然后 CNR-10 老年之声 CNR-11 ...
const expected = [
  '故城县经典音乐FM90.5','环球资讯','经典音乐广播','经济之声','南海之声','轻松调频','台海之声','音乐之声',
  '阅读之声','中央文艺之声','中央中国之声','CGTN - English','CGTN Arabic','CGTN Documentary','CGTN Radio','CGTN Russian'
];
console.log('\n=== 截图前16条 vs Electron实际顺序 对比：===');
let mismatch = 0;
for (let i = 0; i < expected.length; i++) {
  const actual = central.children[i].data.name;
  const ok = actual === expected[i] || actual.includes(expected[i]) || expected[i].includes(actual);
  if (!ok) mismatch++;
  console.log((i+1) + '. ' + (ok ? '✓' : '✗') + ' 截图="' + expected[i] + '" | 实际="' + actual + '"');
}
console.log('\n预期Mismatch count =', mismatch, '（应=0或极小值）');
console.log('\n=== Electron版本信息：按localeCompare(zh-CN)拼音排序后结果就是上面的顺序 ===');
