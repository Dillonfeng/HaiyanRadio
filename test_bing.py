import urllib.request
import urllib.parse
import re

search_url = 'https://www.bing.com/images/search?q=' + urllib.parse.quote('北京音乐广播 电台 logo') + '&count=5'

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.bing.com/'
}

try:
    req = urllib.request.Request(search_url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode('utf-8')
        
        print(f'Response length: {len(html)}')
        
        img_urls = re.findall(r'(https?://[^\s"\']+\.(jpg|png|webp))', html, re.IGNORECASE)
        if img_urls:
            print(f'Found {len(img_urls)} image URLs')
            for url, ext in img_urls[:10]:
                print(f'  {url}')
        else:
            print('No image URL found')
            
except Exception as e:
    print(f'Error: {e}')
