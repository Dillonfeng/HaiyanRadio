const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const LOG_FILE = path.join(__dirname, 'scheduler.log');

function log(msg) {
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const logEntry = `[${timestamp}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, logEntry, 'utf-8');
  console.log(logEntry.trim());
}

let isRunning = false;

async function runBatch(batchSize = 50, delay = 10) {
  if (isRunning) {
    return { success: false, error: '任务已在执行中' };
  }
  isRunning = true;
  try {
    log(`批量获取台标，数量: ${batchSize}，间隔: ${delay}s`);
    
    const pythonProcess = spawn('python', [
      path.join(__dirname, 'fetch_logos.py'),
      String(batchSize),
      String(delay)
    ], {
      cwd: __dirname,
      windowsHide: true
    });

    let output = '';
    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      lines.forEach(line => log(`[Python] ${line}`));
    });

    return new Promise((resolve) => {
      pythonProcess.on('close', (code) => {
        if (code === 0) {
          log('批量获取任务执行成功');
          resolve({ success: true, output: output.trim() });
        } else {
          log(`批量获取任务执行失败，退出码: ${code}`);
          resolve({ success: false, error: `Process exited with code ${code}`, output: output.trim() });
        }
        isRunning = false;
      });

      pythonProcess.on('error', (err) => {
        log(`启动Python进程失败: ${err.message}`);
        resolve({ success: false, error: err.message });
        isRunning = false;
      });
    });
  } catch (err) {
    isRunning = false;
    return { success: false, error: err.message };
  }
}

function fetchSingleLogo(name, url = '') {
  return new Promise((resolve) => {
    log(`获取单个台标: ${name}`);
    
    const pythonProcess = spawn('python', [
      path.join(__dirname, 'fetch_logos.py'),
      '--single',
      name,
      url
    ], {
      cwd: __dirname,
      windowsHide: true
    });

    let output = '';
    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      lines.forEach(line => log(`[Python] ${line}`));
    });

    pythonProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(output.trim());
          if (result.success) {
            log(`台标获取成功: ${name}`);
            resolve(result);
          } else {
            log(`台标获取失败: ${name}`);
            resolve(result);
          }
        } catch (e) {
          log(`解析结果失败: ${e.message}`);
          resolve({ success: false });
        }
      } else {
        log(`台标获取失败，退出码: ${code}`);
        resolve({ success: false });
      }
    });

    pythonProcess.on('error', (err) => {
      log(`启动Python进程失败: ${err.message}`);
      resolve({ success: false });
    });
  });
}

function getStatus() {
  return {
    isRunning: isRunning
  };
}

module.exports = {
  runBatch,
  fetchSingleLogo,
  getStatus
};
