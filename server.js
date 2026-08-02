const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const logoScheduler = require('./logoScheduler');

const PORT = 8080;
const WWW_DIR = path.join(__dirname, 'mobile', 'www');

// V85: 自动枚举本机局域网 IPv4 地址（跳过回环/虚拟网卡），启动日志里直接打印给用户复制粘贴
function getLanIPv4() {
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(nets || {})) {
      (nets[name] || []).forEach(n => {
        if (!n || n.family !== 'IPv4' || n.internal) return;
        const ip = String(n.address || '');
        const low = ip.toLowerCase();
        // 跳过 Docker / WSL / VMware / 虚拟适配器 / 169.254 APIPA / 点对点子网
        if (ip.startsWith('169.254.')) return;
        if (/veth|docker|wsl|vmware|virtual|hyper-v|bridge|hamachi|tailscale|tunnel|loopback/i.test(name || '')) return;
        const isPrivate =
          ip.startsWith('192.168.') ||
          ip.startsWith('10.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
        if (!isPrivate) return;
        // 前缀优先级：192.168.x（家庭/办公最常见）> 172.16-31.x > 10.x.x.x
        const pri = ip.startsWith('192.168.') ? 0 : ip.startsWith('172.') ? 1 : 2;
        candidates.push({ ip, name: name || '', pri });
      });
    }
    candidates.sort((a, b) => a.pri - b.pri || a.name.localeCompare(b.name));
    return candidates.map(c => c.ip);
  } catch (e) { return []; }
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  // API: 获取单个台标
  if (pathname === '/api/fetch-logo') {
    const params = new URLSearchParams(req.url.split('?')[1]);
    const name = params.get('name');
    const url = params.get('url') || '';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    logoScheduler.fetchSingleLogo(name, url).then(result => {
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // API: 批量获取台标
  if (pathname === '/api/batch-fetch') {
    const params = new URLSearchParams(req.url.split('?')[1]);
    const batchSize = parseInt(params.get('size')) || 50;
    const delay = parseFloat(params.get('delay')) || 10;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    logoScheduler.runBatch(batchSize, delay).then(result => {
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // API: 获取定时任务状态
  if (pathname === '/api/scheduler-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(logoScheduler.getStatus()));
    return;
  }

  // API: 获取logo获取进度
  if (pathname === '/api/logo-progress') {
    try {
      const progressPath = path.join(__dirname, 'logo_fetch_progress.json');
      const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(progress));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: 手动触发批量获取
  if (pathname === '/api/start-fetch') {
    const params = new URLSearchParams(req.url.split('?')[1]);
    const batchSize = parseInt(params.get('size')) || 50;
    const delay = parseFloat(params.get('delay')) || 10;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    
    logoScheduler.runBatch(batchSize, delay).then(result => {
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // HLS代理: 解决跨域问题
  if (pathname.startsWith('/api/hls-proxy')) {
    const params = new URLSearchParams(req.url.split('?')[1]);
    const targetUrl = params.get('url');
    
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少URL参数' }));
      return;
    }

    const protocol = targetUrl.startsWith('https') ? https : http;
    
    const proxyReq = protocol.get(targetUrl, {
      headers: {
        'User-Agent': 'RetroRadio/1.0',
        'Referer': targetUrl
      }
    }, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers['content-security-policy'];
      delete headers['x-frame-options'];
      delete headers['x-content-type-options'];
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Origin';
      
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    req.on('close', () => {
      proxyReq.destroy();
    });

    return;
  }

  // 静态文件
  let filePath;
  if (pathname === '/') {
    filePath = path.join(WWW_DIR, 'index.html');
  } else {
    filePath = path.join(WWW_DIR, pathname.replace(/^\//, ''));
  }

  // 安全检查：防止路径穿越
  if (!filePath.startsWith(WWW_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const extname = path.extname(filePath);
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

async function startAutoFetch() {
  console.log(`\n========================================`);
  console.log(`  启动时自动获取缺失logo`);
  console.log(`========================================`);
  
  try {
    const result = await logoScheduler.runBatch(50, 10);
    if (result.success) {
      console.log(`  批量获取完成`);
    } else {
      console.log(`  批量获取失败: ${result.error}`);
    }
  } catch (err) {
    console.log(`  批量获取异常: ${err.message}`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  const lanIps = getLanIPv4();
  console.log(`========================================`);
  console.log(`  移动端服务器已启动`);
  console.log(`========================================`);
  console.log(`  本地访问:  http://localhost:${PORT}`);
  if (lanIps.length === 0) {
    console.log(`  局域网访问: http://<你的IP地址>:${PORT}  （未检测到可用内网IP）`);
  } else {
    lanIps.forEach((ip, i) => {
      const mark = i === 0 ? '（推荐手机端填这个）' : '';
      console.log(`  局域网访问: http://${ip}:${PORT}  ${mark}`);
    });
  }
  console.log(`========================================`);
  console.log(`  API端点:`);
  console.log(`    GET /api/fetch-logo?name=电台名&url=电台URL`);
  console.log(`    GET /api/batch-fetch?size=50&delay=10`);
  console.log(`    GET /api/scheduler-status`);
  console.log(`    GET /api/logo-progress`);
  console.log(`    GET /api/start-fetch`);
  console.log(`========================================`);
  
  startAutoFetch();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请先关闭占用该端口的程序`);
  } else {
    console.error(`服务器错误: ${err.message}`);
  }
  process.exit(1);
});

console.log('按 Ctrl+C 停止服务器');
