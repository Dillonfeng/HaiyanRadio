import json
import re

with open(r'd:\Trae Work\RetroRadioDesktop\mobile\www\channels.js', 'r', encoding='utf-8') as f:
    content = f.read()

start = content.find('{')
end = content.rfind('}') + 1
json_str = content[start:end]
data = json.loads(json_str)
radio_channels = data['radio']

with open(r'd:\Trae Work\RetroRadioDesktop\radio_logos_full.json', 'r', encoding='utf-8-sig') as f:
    logos = json.load(f)

logo_map = {}
for logo in logos:
    name = logo['name'].strip()
    if name:
        logo_map[name] = logo['logo']

updated_count = 0

for ch in radio_channels:
    if 'logo' in ch and ch['logo']:
        continue
    
    name = ch['name']
    url = ch['url']
    
    qtfm_match = re.search(r'https?://.*?qtfm\.cn/live/(\d+)', url)
    qingting_match = re.search(r'https?://.*?qingting\.fm/live/(\d+)', url)
    
    found_logo = None
    
    if name in logo_map:
        found_logo = logo_map[name]
    else:
        for logo_name in logo_map:
            if name in logo_name or logo_name in name:
                found_logo = logo_map[logo_name]
                break
    
    if found_logo:
        ch['logo'] = found_logo
        updated_count += 1
        print(f"Updated: {name} -> {found_logo}")

print(f"\nTotal updated: {updated_count}")

with open(r'd:\Trae Work\RetroRadioDesktop\mobile\www\channels.js', 'w', encoding='utf-8') as f:
    f.write('const CHANNEL_DATA = ')
    f.write(json.dumps(data, ensure_ascii=False, indent=2))
    f.write(';')

print("Saved to channels.js")