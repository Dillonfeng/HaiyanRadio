import urllib.request
import urllib.parse
import json
import random

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
]

HEADERS = {
    'User-Agent': random.choice(USER_AGENTS),
    'Referer': 'https://www.qtfm.cn/',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.qtfm.cn'
}

def test_search(name):
    search_url = f'https://www.qtfm.cn/api/search/search?keyword={urllib.parse.quote(name)}&type=radio&page=1&pageSize=5'
    
    try:
        headers = HEADERS.copy()
        headers['User-Agent'] = random.choice(USER_AGENTS)
        
        req = urllib.request.Request(search_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print(f'搜索 "{name}":')
            print(f'  响应: {json.dumps(data, ensure_ascii=False)[:500]}')
            
            if data.get('data') and data['data'].get('radios'):
                for radio in data['data']['radios']:
                    print(f'  找到: {radio.get("name", "未知")}')
                    for field in ['imgUrl', 'logo', 'image', 'cover']:
                        if field in radio and radio[field]:
                            print(f'    {field}: {radio[field]}')
    except Exception as e:
        print(f'  错误: {e}')

test_search('北京音乐广播')
test_search('中央人民广播电台')
test_search('BBC')
