import json
import os
import re
import urllib.request
import urllib.error
import time
import hashlib
import random
from datetime import datetime, timedelta

CHANNELS_FILE = r'd:\Trae Work\RetroRadioDesktop\mobile\www\channels.js'
LOCAL_LOGOS_DIR = r'd:\Trae Work\RetroRadioDesktop\mobile\www\logos'
PROGRESS_FILE = r'd:\Trae Work\RetroRadioDesktop\logo_fetch_progress.json'
LOG_FILE = r'd:\Trae Work\RetroRadioDesktop\logo_fetch.log'

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
]

HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.qtfm.cn/',
}

def log(msg):
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_entry = f'[{timestamp}] {msg}\n'
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(log_entry)
    print(log_entry.strip())

def load_channels():
    with open(CHANNELS_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
    start = content.find('{')
    end = content.rfind('}') + 1
    json_str = content[start:end]
    data = json.loads(json_str)
    return data['radio']

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        'fetched': [],
        'failed': {},
        'last_fetch_time': None,
        'total_fetched': 0,
        'total_failed': 0,
    }

def save_progress(progress):
    with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)

def get_file_extension(url):
    lower_url = url.lower()
    if '.png' in lower_url:
        return '.png'
    elif '.jpg' in lower_url or '.jpeg' in lower_url:
        return '.jpg'
    elif '.webp' in lower_url:
        return '.webp'
    elif '.gif' in lower_url:
        return '.gif'
    elif '.svg' in lower_url:
        return '.svg'
    return '.png'

def download_image(url, save_path, max_retries=3):
    for attempt in range(max_retries):
        try:
            headers = HEADERS.copy()
            headers['User-Agent'] = random.choice(USER_AGENTS)
            
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                content = resp.read()
                
                if len(content) < 500:
                    log(f'  文件太小: {len(content)} bytes')
                    return False
                
                content_type = resp.headers.get('Content-Type', '')
                if 'text/html' in content_type:
                    log(f'  返回HTML')
                    return False
                
                with open(save_path, 'wb') as f:
                    f.write(content)
                
                log(f'  下载成功: {len(content)} bytes')
                return True
                
        except urllib.error.HTTPError as e:
            log(f'  HTTP错误 {e.code}')
            if e.code == 404:
                return False
        except urllib.error.URLError as e:
            log(f'  网络错误: {e.reason}')
        except Exception as e:
            log(f'  未知错误: {str(e)[:30]}')
        
        if attempt < max_retries - 1:
            sleep_time = 2 ** attempt + random.uniform(0, 1)
            log(f'  重试 {attempt + 1}/{max_retries}，等待 {sleep_time:.1f}s')
            time.sleep(sleep_time)
    
    return False

def get_radio_id_from_url(url):
    qtfm_match = re.search(r'https?://.*?qtfm\.cn/live/(\d+)', url)
    qingting_match = re.search(r'https?://.*?qingting\.fm/live/(\d+)', url)
    if qtfm_match:
        return ('qtfm', qtfm_match.group(1))
    elif qingting_match:
        return ('qingting', qingting_match.group(1))
    return (None, None)

def fetch_logo_from_qtfm_page(radio_id):
    page_url = f'https://www.qtfm.cn/radios/{radio_id}/'
    
    try:
        headers = HEADERS.copy()
        headers['User-Agent'] = random.choice(USER_AGENTS)
        
        req = urllib.request.Request(page_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode('utf-8', errors='ignore')
            
            imgUrl_pattern = r'"imgUrl"\s*:\s*"([^"]+)"'
            matches = re.findall(imgUrl_pattern, content)
            for match in matches:
                if match and 'pic.qtfm.cn' in match:
                    if match.startswith('//'):
                        match = 'https:' + match
                    return match
            
            window_data_pattern = r'window\.__initStores\s*=\s*(\{.*?\});'
            window_matches = re.search(window_data_pattern, content, re.DOTALL)
            if window_matches:
                try:
                    store_str = window_matches.group(1)
                    store_obj = json.loads(store_str)
                    
                    if store_obj.get('RadioDetailStore') and store_obj['RadioDetailStore'].get('radio'):
                        radio_data = store_obj['RadioDetailStore']['radio']
                        for field in ['imgUrl', 'logo', 'image']:
                            if field in radio_data and radio_data[field]:
                                url = radio_data[field]
                                if 'pic.qtfm.cn' in url:
                                    if url.startswith('//'):
                                        url = 'https:' + url
                                    return url
                except json.JSONDecodeError:
                    pass
            
            pic_matches = re.findall(r'https?://pic\.qtfm\.cn/\d{4}/\d{4}/[^"\']+', content)
            for match in pic_matches:
                if match.endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    return match
            
            return None
    except Exception as e:
        log(f'  页面获取错误: {str(e)[:30]}')
        return None

def fetch_logo_from_qtfm_api(radio_id):
    api_urls = [
        f'https://www.qtfm.cn/api/radio/getRadioInfo?radioId={radio_id}',
        f'https://lhttp.qtfm.cn/api/radio/getRadioInfo?radioId={radio_id}',
    ]
    
    for api_url in api_urls:
        try:
            headers = HEADERS.copy()
            headers['User-Agent'] = random.choice(USER_AGENTS)
            headers['Accept'] = 'application/json, text/plain, */*'
            
            req = urllib.request.Request(api_url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                try:
                    data = json.loads(resp.read().decode('utf-8'))
                    
                    if isinstance(data, dict):
                        if 'data' in data and isinstance(data['data'], dict):
                            for field in ['imgUrl', 'logo', 'image', 'cover']:
                                if field in data['data'] and data['data'][field]:
                                    url = data['data'][field]
                                    if 'pic.qtfm.cn' in url:
                                        if url.startswith('//'):
                                            url = 'https:' + url
                                        return url
                        for field in ['imgUrl', 'logo', 'image', 'cover']:
                            if field in data and data[field]:
                                url = data[field]
                                if 'pic.qtfm.cn' in url:
                                    if url.startswith('//'):
                                        url = 'https:' + url
                                    return url
                except json.JSONDecodeError:
                    continue
        except Exception:
            continue
    
    return None

def fetch_single_logo(channel, progress):
    name = channel['name']
    url = channel['url']
    radio_type, radio_id = get_radio_id_from_url(url)
    
    if name in progress['fetched']:
        log(f'跳过已获取: {name}')
        return None
    if name in progress['failed']:
        last_attempt = progress['failed'].get(name)
        if last_attempt:
            last_time = datetime.fromisoformat(last_attempt)
            if datetime.now() - last_time < timedelta(days=7):
                log(f'跳过近期失败的: {name}')
                return None
    
    log(f'处理: {name}')
    
    logo_url = None
    
    if radio_type == 'qtfm' and radio_id:
        log(f'  尝试API获取 (ID: {radio_id})')
        logo_url = fetch_logo_from_qtfm_api(radio_id)
    
    if not logo_url and radio_type == 'qtfm' and radio_id:
        log(f'  尝试页面获取')
        logo_url = fetch_logo_from_qtfm_page(radio_id)
    
    if logo_url:
        name_hash = hashlib.md5(name.encode('utf-8')).hexdigest()[:8]
        ext = get_file_extension(logo_url)
        save_path = os.path.join(LOCAL_LOGOS_DIR, f'{name_hash}{ext}')
        
        if os.path.exists(save_path):
            log(f'  本地已存在')
            return save_path
        
        log(f'  下载: {logo_url}')
        if download_image(logo_url, save_path):
            return save_path
        else:
            progress['failed'][name] = datetime.now().isoformat()
            progress['total_failed'] += 1
    else:
        progress['failed'][name] = datetime.now().isoformat()
        progress['total_failed'] += 1
        log(f'  未找到台标')
    
    return None

def main(batch_size=20, delay=2):
    log('=' * 60)
    log('开始获取电台台标 (v4)')
    log('=' * 60)
    
    channels = load_channels()
    progress = load_progress()
    
    qtfm_channels = [ch for ch in channels if 'qtfm.cn' in ch['url']]
    need_fetch = [ch for ch in qtfm_channels if ch['name'] not in progress['fetched']]
    
    log(f'总电台数: {len(channels)}')
    log(f'蜻蜓FM电台: {len(qtfm_channels)}')
    log(f'已获取: {len(progress["fetched"])}')
    log(f'待获取: {len(need_fetch)}')
    log(f'本次计划获取: {min(batch_size, len(need_fetch))}')
    
    success_count = 0
    for i, channel in enumerate(need_fetch[:batch_size]):
        logo_path = fetch_single_logo(channel, progress)
        
        if logo_path:
            progress['fetched'].append(channel['name'])
            progress['total_fetched'] += 1
            success_count += 1
            
            channel['logo'] = f'logos/{os.path.basename(logo_path)}'
        
        if i < batch_size - 1 and i < len(need_fetch) - 1:
            sleep_time = delay + random.uniform(0, 1)
            time.sleep(sleep_time)
    
    progress['last_fetch_time'] = datetime.now().isoformat()
    save_progress(progress)
    
    with open(CHANNELS_FILE, 'w', encoding='utf-8') as f:
        f.write('const CHANNEL_DATA = ')
        data = {'radio': channels}
        f.write(json.dumps(data, ensure_ascii=False, indent=2))
        f.write(';')
    
    log('=' * 60)
    log(f'本次完成: {success_count}/{min(batch_size, len(need_fetch))}')
    log(f'累计已获取: {progress["total_fetched"]}')
    log(f'累计失败: {progress["total_failed"]}')
    log('=' * 60)

if __name__ == '__main__':
    import sys
    batch_size = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    delay = float(sys.argv[2]) if len(sys.argv) > 2 else 2
    main(batch_size, delay)