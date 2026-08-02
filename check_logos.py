import json
with open(r'd:\Trae Work\RetroRadioDesktop\mobile\www\channels.js', 'r', encoding='utf-8') as f:
    content = f.read()
start = content.find('{')
end = content.rfind('}') + 1
json_str = content[start:end]
data = json.loads(json_str)
radios = data['radio']
logos = [ch for ch in radios if 'logo' in ch and ch['logo']]
print(f'Has logo: {len(logos)}')
for ch in logos[:10]:
    print(f"  {ch['name']}: {ch['logo']}")