import json
import os
import re
import urllib.request
import urllib.error
import time
import hashlib
import random
import sys
from datetime import datetime, timedelta

CHANNELS_FILE = r'd:\Trae Work\RetroRadioDesktop\mobile\www\channels.js'
LOCAL_LOGOS_DIR = r'd:\Trae Work\RetroRadioDesktop\mobile\www\logos'
PROGRESS_FILE = r'd:\Trae Work\RetroRadioDesktop\logo_fetch_progress.json'
LOG_FILE = r'd:\Trae Work\RetroRadioDesktop\logo_fetch.log'

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
]

HEADERS = {
    'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.qtfm.cn/',
}

REQUEST_TIMES = []
MAX_REQUESTS_PER_MINUTE = 8
MIN_REQUEST_INTERVAL = 10

def log(msg):
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_entry = f'[{timestamp}] {msg}\n'
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(log_entry)
    sys.stderr.write(log_entry)

def rate_limit():
    now = time.time()
    REQUEST_TIMES[:] = [t for t in REQUEST_TIMES if now - t < 60]
    
    if len(REQUEST_TIMES) >= MAX_REQUESTS_PER_MINUTE:
        wait_time = 60 - (now - REQUEST_TIMES[0]) + 1
        log(f'  频率限制，等待 {wait_time:.1f}s')
        time.sleep(wait_time)
    
    REQUEST_TIMES.append(time.time())
    
    if len(REQUEST_TIMES) > 1:
        last_request = REQUEST_TIMES[-2]
        elapsed = now - last_request
        if elapsed < MIN_REQUEST_INTERVAL:
            wait_time = MIN_REQUEST_INTERVAL - elapsed
            log(f'  间隔限制，等待 {wait_time:.1f}s')
            time.sleep(wait_time)

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
                
                if len(content) < 100:
                    log(f'  文件太小，可能是错误页面: {len(content)} bytes')
                    return False
                
                with open(save_path, 'wb') as f:
                    f.write(content)
                
                log(f'  下载成功: {len(content)} bytes')
                return True
                
        except urllib.error.HTTPError as e:
            log(f'  HTTP错误 {e.code}: {url}')
            if e.code == 404:
                return False
            if e.code == 429 or e.code == 403:
                log(f'  触发限流，等待 {(attempt + 1) * 30}s')
                time.sleep((attempt + 1) * 30)
        except urllib.error.URLError as e:
            log(f'  网络错误: {e.reason}')
        except Exception as e:
            log(f'  未知错误: {str(e)}')
        
        if attempt < max_retries - 1:
            sleep_time = min(2 ** attempt * 5 + random.uniform(0, 2), 60)
            log(f'  重试 {attempt + 1}/{max_retries}，等待 {sleep_time:.1f}s')
            time.sleep(sleep_time)
    
    return False

def get_radio_id_from_url(url):
    qtfm_match = re.search(r'https?://.*?qtfm\.cn/live/(\d+)', url)
    qingting_match = re.search(r'https?://.*?qingting\.fm/live/(\d+)', url)
    if qtfm_match:
        return qtfm_match.group(1)
    elif qingting_match:
        return qingting_match.group(1)
    return None

def fetch_logo_from_api(radio_id):
    api_urls = [
        f'https://www.qtfm.cn/api/radio/getRadioInfo?radioId={radio_id}',
        f'https://api.qingting.fm/v1/radio/{radio_id}',
    ]
    
    for api_url in api_urls:
        try:
            rate_limit()
            headers = HEADERS.copy()
            headers['User-Agent'] = random.choice(USER_AGENTS)
            
            req = urllib.request.Request(api_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                try:
                    data = json.loads(resp.read().decode('utf-8'))
                    
                    img_fields = ['imgUrl', 'logo', 'image', 'cover', 'icon']
                    for field in img_fields:
                        if isinstance(data, dict):
                            if 'data' in data and isinstance(data['data'], dict):
                                if field in data['data'] and data['data'][field]:
                                    return data['data'][field]
                            if field in data and data[field]:
                                return data[field]
                except json.JSONDecodeError:
                    continue
        except Exception:
            continue
    
    return None

def fetch_logo_from_search(name):
    search_urls = [
        f'https://www.qtfm.cn/api/search/search?keyword={urllib.parse.quote(name)}&type=radio&page=1&pageSize=5',
        f'https://www.qtfm.cn/search?keyword={urllib.parse.quote(name)}',
    ]
    
    for search_url in search_urls:
        try:
            rate_limit()
            headers = HEADERS.copy()
            headers['User-Agent'] = random.choice(USER_AGENTS)
            
            req = urllib.request.Request(search_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                try:
                    data = json.loads(resp.read().decode('utf-8'))
                    
                    if data.get('data') and data['data'].get('radios'):
                        for radio in data['data']['radios']:
                            for field in ['imgUrl', 'logo', 'image', 'cover']:
                                if field in radio and radio[field]:
                                    return radio[field]
                except json.JSONDecodeError:
                    html = resp.read().decode('utf-8')
                    img_match = re.search(r'https?://[^\s"\']+logo[^\s"\']*\.(jpg|png|webp)', html, re.IGNORECASE)
                    if img_match:
                        return img_match.group(0)
        except Exception:
            pass
    
    return None

def fetch_logo_from_ximalaya(name):
    search_url = f'https://www.ximalaya.com/revision/search/main?core=album&kw={urllib.parse.quote(name)}&page=1&pageSize=10'
    
    try:
        rate_limit()
        headers = HEADERS.copy()
        headers['User-Agent'] = random.choice(USER_AGENTS)
        headers['Referer'] = 'https://www.ximalaya.com/'
        
        req = urllib.request.Request(search_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            
            if data.get('data') and data['data'].get('albums'):
                for album in data['data']['albums']:
                    if album.get('coverUrl'):
                        return album['coverUrl']
    except Exception:
        pass
    
    return None

def fetch_logo_from_url(url):
    if not url:
        return None
    
    try:
        rate_limit()
        headers = HEADERS.copy()
        headers['User-Agent'] = random.choice(USER_AGENTS)
        
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            content_type = resp.headers.get('Content-Type', '')
            if content_type.startswith('image/'):
                return url
            
            try:
                html = resp.read().decode('utf-8')
                img_patterns = [
                    r'https?://[^\s"\']+\.(jpg|jpeg|png|webp|gif)',
                    r'logo[\s\S]*?https?://[^\s"\']+\.(jpg|png|webp)',
                ]
                for pattern in img_patterns:
                    match = re.search(pattern, html, re.IGNORECASE)
                    if match:
                        return match.group(0)
            except Exception:
                pass
    except Exception:
        pass
    
    return None

def fetch_logo_from_bing(name):
    search_url = f'https://www.bing.com/images/search?q={urllib.parse.quote(name + " 电台 logo")}&count=10'
    
    try:
        rate_limit()
        headers = HEADERS.copy()
        headers['User-Agent'] = random.choice(USER_AGENTS)
        headers['Referer'] = 'https://www.bing.com/'
        
        req = urllib.request.Request(search_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode('utf-8')
            
            img_urls = re.findall(r'(https?://[^\s"\']+\.(jpg|png|webp))', html, re.IGNORECASE)
            if img_urls:
                for url, ext in img_urls:
                    if 'bing.com/sa/simg' in url:
                        continue
                    if '699pic.com' in url:
                        continue
                    if 'baike.so.com' in url:
                        continue
                    if '/tupian-' in url:
                        continue
                    if 'photo/50' in url and '699pic' in url:
                        continue
                    if 'sinakd' in url:
                        continue
                    clean_url = url.split('&quot;')[0].split('"')[0]
                    if clean_url != url:
                        return clean_url
                    return url
    except Exception:
        pass
    
    return None

def fetch_single_logo(channel, progress, force=False):
    name = channel['name']
    url = channel.get('url', '')
    radio_id = get_radio_id_from_url(url)
    
    if not force:
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
    
    if radio_id:
        log(f'  尝试API获取 (ID: {radio_id})')
        logo_url = fetch_logo_from_api(radio_id)
    
    if not logo_url:
        log(f'  尝试搜索获取')
        logo_url = fetch_logo_from_search(name)
    
    if not logo_url:
        log(f'  尝试搜索获取（简化名称）')
        simple_name = re.sub(r'[（）()]', '', name)
        if simple_name != name:
            logo_url = fetch_logo_from_search(simple_name)
    
    if not logo_url:
        log(f'  尝试搜索获取（去除FM）')
        no_fm_name = re.sub(r'FM[\d.]+', '', name).strip()
        if no_fm_name != name and no_fm_name:
            logo_url = fetch_logo_from_search(no_fm_name)
    
    if not logo_url:
        log(f'  尝试喜马拉雅搜索')
        logo_url = fetch_logo_from_ximalaya(name)
    
    if not logo_url:
        log(f'  尝试URL页面提取')
        logo_url = fetch_logo_from_url(url)
    
    if not logo_url:
        log(f'  尝试Bing图片搜索')
        logo_url = fetch_logo_from_bing(name)
    
    if logo_url:
        if logo_url.startswith('//'):
            logo_url = 'https:' + logo_url
        
        name_hash = hashlib.md5(name.encode('utf-8')).hexdigest()[:8]
        ext = get_file_extension(logo_url)
        save_path = os.path.join(LOCAL_LOGOS_DIR, f'{name_hash}{ext}')
        
        if os.path.exists(save_path):
            log(f'  本地已存在: {os.path.basename(save_path)}')
            return save_path
        
        log(f'  下载: {logo_url}')
        rate_limit()
        if download_image(logo_url, save_path):
            return save_path
        else:
            progress['failed'][name] = datetime.now().isoformat()
            progress['total_failed'] += 1
    else:
        progress['failed'][name] = datetime.now().isoformat()
        progress['total_failed'] += 1
        log(f'  未找到logo')
    
    return None

def fetch_single_logo_by_name(name, url=''):
    progress = load_progress()
    
    channel = {'name': name, 'url': url}
    logo_path = fetch_single_logo(channel, progress, force=False)
    
    if logo_path:
        progress['fetched'].append(name)
        progress['total_fetched'] += 1
        save_progress(progress)
        
        channels = load_channels()
        for ch in channels:
            if ch['name'] == name:
                ch['logo'] = f'logos/{os.path.basename(logo_path)}'
                break
        
        with open(CHANNELS_FILE, 'w', encoding='utf-8') as f:
            f.write('const CHANNEL_DATA = ')
            data = {'radio': channels}
            f.write(json.dumps(data, ensure_ascii=False, indent=2))
            f.write(';')
        
        return {'success': True, 'logo_path': logo_path}
    
    return {'success': False}

def main(batch_size=50, delay=10):
    global MIN_REQUEST_INTERVAL
    MIN_REQUEST_INTERVAL = delay
    
    log('=' * 60)
    log('开始获取电台台标')
    log(f'批量大小: {batch_size}, 请求间隔: {delay}s')
    log('=' * 60)
    
    channels = load_channels()
    progress = load_progress()
    
    need_fetch = [ch for ch in channels if ch['name'] not in progress['fetched']]
    log(f'总电台数: {len(channels)}')
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
    if len(sys.argv) > 1 and sys.argv[1] == '--single':
        name = sys.argv[2] if len(sys.argv) > 2 else ''
        url = sys.argv[3] if len(sys.argv) > 3 else ''
        if name:
            result = fetch_single_logo_by_name(name, url)
            print(json.dumps(result))
    else:
        batch_size = int(sys.argv[1]) if len(sys.argv) > 1 else 50
        delay = float(sys.argv[2]) if len(sys.argv) > 2 else 10
        main(batch_size, delay)
