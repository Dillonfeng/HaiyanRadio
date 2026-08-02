// V70 order check: copy mobile app.js processChannels logic
const fs = require('fs');
const path = require('path');
const channelsSrc = fs.readFileSync(path.join(__dirname, 'mobile','www','channels.js'), 'utf8');
// wrap channels.js: window.CHANNEL_DATA -> global.CHANNEL_DATA
eval(channelsSrc.replace('window.CHANNEL_DATA','global.CHANNEL_DATA'));
global.window = global;

const appSrc = fs.readFileSync(path.join(__dirname, 'mobile','www','app.js'), 'utf8');
// Strip browser/event handlers: find regions/categories/backupStations + processChannels function
// Extract these functions/data:
const FNs = ['regions','categories','backupStations','isGarbage','isValidUrl','normalizeFrequency','isRegionValid','detectRegion','processChannels'];
for (const name of FNs) {
  const idx1 = appSrc.indexOf('const '+name+' ');
  const idx2 = appSrc.indexOf('let '+name+' ');
  console.log('  ',name, 'const@',idx1,'let@',idx2);
}
// Now extract block for processChannels (start at line ~"function processChannels(")
// Extract dataSet: mock const dataSet = CHANNEL_DATA
const mockCode = `
const CHANNEL_DATA = global.CHANNEL_DATA;
const dataSet = CHANNEL_DATA;
`;
// Just eval the entire mobile/www/app.js content minus DOM references
eval(mockCode + appSrc);

// Test: if processChannels is a function
if (typeof processChannels === 'function') {
  const out = processChannels(dataSet);
  const r = out.radio;
  console.log('\n========== MOBILE processChannels (v70) ==========');
  console.log('总数:', r.length, '/ expected: 1652');
  const zy = r.filter(x => x.description && (x.description === '中央' || String(x.description).includes('中央')));
  console.log('中央分组数量:', zy.length, '/ expected 32');
  console.log('\n中央前20条顺序:');
  zy.slice(0,20).forEach((s,i)=>console.log(String(i+1).padStart(3,' ')+'. '+s.name.padEnd(24,' ')+'  '+s.url.substring(0,80)));
  console.log('\n经济之声/经典音乐广播URL:');
  zy.forEach(s => { if (s.name.includes('经济之声')||s.name.includes('经典音乐广播')||(s.url&&(s.url.includes('/jjzs/')||s.url.includes('/dszs/'))) {
    console.log('  '+s.name+' URL='+s.url);
  }});
  let cntWs=0, cntHttpN=0, cntHttpS=0;
  r.forEach(s => {
    if (s.url && s.url.includes('satellitepull.cnr.cn') && s.url.includes('wsSession=')) cntWs++;
    if (s.url && s.url.startsWith('http://ngcdn')) cntHttpN++;
    if (s.url && s.url.startsWith('https://ngcdn')) cntHttpS++;
  });
  console.log('\nsatellitepull wsSession残留(期望0):', cntWs);
  console.log('HTTP ngcdn(期望0):', cntHttpN);
  console.log('HTTPS ngcdn(期望>0):', cntHttpS);
}
