// Test V70: 还原Electron版processChannels后的radio数组（顺序+总数+URL正确性）
// 运行: node test_v70_order_check.js
const fs = require('fs');
const path = require('path');
process.chdir(__dirname);

// Load Electron app.js to get the REAL processChannels + dataSet + regions + categories + backupStations
const electronSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
// 截取dataSet (CHANNEL_DATA variable in channels.js will be same as Electron dataSet)
const channelsSrc = fs.readFileSync(path.join(__dirname, 'mobile','www','channels.js'), 'utf8');
eval(channelsSrc.replace('window.CHANNEL_DATA','global.CHANNEL_DATA') + '\n' +
     electronSrc.replace('if (typeof process === \'object\')','var NODE = true; if (NODE)') +
    `;
     console.log('Electron version real dataSet length:', dataSet.radio.length);
     const result = processChannels(dataSet);
     const r = result.radio;
     console.log('去重后总数uniqueRadio.length:', r.length);
     const zy = r.filter(x => x.description === '中央' || x.description.includes('中央'));
     console.log('中央分组电台数:', zy.length);
     console.log('中央前15条顺序:');
     zy.slice(0,15).forEach((s,i)=>console.log('  '+(i+1)+'. '+s.name+'  URL='+s.url+'  desc='+s.description));
     // Find jjzs & dszs
     console.log('');
     zy.forEach(s => {
       if (s.name.includes('经济之声') || s.name.includes('经典音乐广播') || (s.url && s.url.includes('/jjzs/')) || (s.url && s.url.includes('/dszs/'))) {
         console.log('TARGET: '+s.name+'  URL='+s.url);
       }
     });
     // Satellitepull wsSession 清理检查
     let cntWsSession = 0;
     r.forEach(s => { if (s.url && s.url.includes('satellitepull.cnr.cn') && s.url.includes('wsSession=')) cntWsSession++; });
     console.log('satellitepull wsSession残留 (期望0):', cntWsSession);
     let cntHttpNgcdn = 0;
     r.forEach(s => { if (s.url && s.url.startsWith('http://ngcdn')) cntHttpNgcdn++; });
     console.log('HTTP ngcdn残留 (期望0):', cntHttpNgcdn);
    `);
