import json
import re
import urllib.request
import time

with open(r'd:\Trae Work\RetroRadioDesktop\mobile\www\channels.js', 'r', encoding='utf-8') as f:
    content = f.read()

start = content.find('{')
end = content.rfind('}') + 1
json_str = content[start:end]
data = json.loads(json_str)
radio_channels = data['radio']

no_logo_channels = [ch for ch in radio_channels if 'logo' not in ch or not ch['logo']]
print(f"Total radio channels: {len(radio_channels)}")
print(f"Without logo: {len(no_logo_channels)}")

results = {}
success_count = 0
failed_count = 0

for idx, ch in enumerate(no_logo_channels):
    name = ch['name']
    url = ch['url']
    
    qtfm_match = re.search(r'https?://.*?qtfm\.cn/live/(\d+)', url)
    qingting_match = re.search(r'https?://.*?qingting\.fm/live/(\d+)', url)
    
    radio_id = None
    if qtfm_match:
        radio_id = qtfm_match.group(1)
    elif qingting_match:
        radio_id = qingting_match.group(1)
    
    print(f"\n[{idx+1}/{len(no_logo_channels)}] {name}")
    
    if radio_id:
        try:
            api_url = f"https://www.qtfm.cn/api/radio/getRadioInfo?radioId={radio_id}"
            req = urllib.request.Request(api_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                api_data = json.loads(resp.read().decode('utf-8'))
                if api_data.get('data') and api_data['data'].get('imgUrl'):
                    logo_url = api_data['data']['imgUrl']
                    if logo_url.startswith('//'):
                        logo_url = 'https:' + logo_url
                    results[name] = {
                        'name': name,
                        'id': radio_id,
                        'logo': logo_url,
                        'source': 'api'
                    }
                    success_count += 1
                    print(f"  ✓ API: {logo_url}")
                else:
                    failed_count += 1
                    print(f"  ✗ No logo in API response")
        except Exception as e:
            failed_count += 1
            print(f"  ✗ API error: {e}")
    else:
        try:
            search_name = name.replace('（', '').replace('）', '').replace('(', '').replace(')', '')
            search_url = f"https://www.qtfm.cn/api/search/search?keyword={urllib.parse.quote(search_name)}&type=radio&page=1&pageSize=5"
            req = urllib.request.Request(search_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                search_data = json.loads(resp.read().decode('utf-8'))
                if search_data.get('data') and search_data['data'].get('radios'):
                    for radio in search_data['data']['radios']:
                        if radio.get('imgUrl'):
                            logo_url = radio['imgUrl']
                            if logo_url.startswith('//'):
                                logo_url = 'https:' + logo_url
                            results[name] = {
                                'name': name,
                                'id': radio.get('id', ''),
                                'logo': logo_url,
                                'source': 'search'
                            }
                            success_count += 1
                            print(f"  ✓ Search: {logo_url}")
                            break
                    else:
                        failed_count += 1
                        print(f"  ✗ No match in search")
                else:
                    failed_count += 1
                    print(f"  ✗ Search returned no results")
        except Exception as e:
            failed_count += 1
            print(f"  ✗ Search error: {e}")
    
    time.sleep(0.3)

print(f"\n=== Summary ===")
print(f"Success: {success_count}")
print(f"Failed: {failed_count}")

with open(r'd:\Trae Work\RetroRadioDesktop\radio_logos_new.json', 'w', encoding='utf-8') as f:
    json.dump(list(results.values()), f, ensure_ascii=False, indent=2)

print(f"Saved to radio_logos_new.json")