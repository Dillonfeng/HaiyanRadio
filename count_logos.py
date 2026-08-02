import json
import re

with open('mobile/www/channels.js', 'r', encoding='utf-8') as f:
    d = f.read()

m = re.search(r'const CHANNEL_DATA = (\{[\s\S]*\});', d)
if m:
    data = json.loads(m.group(1))
    total = len(data['radio'])
    has_logo = len([ch for ch in data['radio'] if ch.get('logo')])
    print(f'Total: {total}')
    print(f'Has logo: {has_logo}')
    print(f'No logo: {total - has_logo}')
