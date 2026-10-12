"""Writes docs/store/index.html: a review page for the Chrome Web Store assets and listing copy.

Run from the repo root: python3 scripts/store-preview.py
"""
import html
import re

LISTING = 'docs/store-listing.md'
OUT = 'docs/store/index.html'


def inline(t):
    t = html.escape(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    t = re.sub(r'(https://[^\s<|]+)', r'<a href="\1">\1</a>', t)
    return t


def listing_html(md):
    out, lines, i = [], md.split('\n'), 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('## Assets'):
            break
        if line.startswith('# ') or line.strip() == '---' or line.startswith('Copy/paste source'):
            i += 1
            continue
        if line.startswith('## '):
            out.append(f'<h2>{inline(line[3:])}</h2>')
        elif line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                if not re.match(r'^\|[-| ]+\|$', lines[i]):
                    rows.append([c.strip() for c in lines[i].strip('|').split('|')])
                i += 1
            cells = lambda r, tag: ''.join(f'<{tag}>{inline(c)}</{tag}>' for c in r)
            out.append('<table><tr>' + cells(rows[0], 'th') + '</tr>' + ''.join('<tr>' + cells(r, 'td') + '</tr>' for r in rows[1:]) + '</table>')
            continue
        elif line.startswith('- '):
            out.append(f'<p class="li">{inline(line[2:])}</p>')
        elif line.strip():
            out.append(f'<p>{inline(line)}</p>')
        i += 1
    return ''.join(out)


SHOTS = [
    ('screenshot-1-switch.jpg', 'Screenshot 1'),
    ('screenshot-2-limits.jpg', 'Screenshot 2'),
    ('screenshot-3-rules.jpg', 'Screenshot 3'),
    ('screenshot-4-platform.jpg', 'Screenshot 4'),
    ('screenshot-5-notify.jpg', 'Screenshot 5'),
]

gallery = ''.join(
    f'<figure><img src="{n}" alt="{t}"><figcaption>{t} · 1280×800 · <code>{n}</code></figcaption></figure>' for n, t in SHOTS
)

page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store Assets Preview</title>
<style>
:root {{ --bg:#1f1e1c; --panel:#2a2927; --text:#efe9e1; --muted:#a8a097; --line:#3a3835; --clay:#d97757; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--text); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }}
main {{ max-width:1320px; margin:0 auto; padding:32px 16px 64px; }}
h1 {{ font-size:28px; margin:0 0 4px; }}
.sub {{ color:var(--muted); margin:0 0 28px; max-width:80ch; }}
h2 {{ font-size:17px; margin:28px 0 8px; }}
h3 {{ font-size:20px; margin:40px 0 14px; padding-top:20px; border-top:1px solid var(--line); }}
figure {{ margin:0 0 22px; }}
figure img {{ display:block; max-width:100%; height:auto; border-radius:10px; border:1px solid var(--line); }}
figcaption {{ color:var(--muted); font-size:13px; margin-top:6px; }}
.row {{ display:flex; gap:24px; flex-wrap:wrap; align-items:flex-start; }}
.icon {{ background:repeating-conic-gradient(#3a3835 0% 25%, #2a2927 0% 50%) 0 0/16px 16px; border-radius:10px; padding:12px; display:inline-block; }}
.icon img {{ border:0; border-radius:0; }}
.copy {{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:8px 24px 20px; max-width:900px; overflow-x:auto; }}
.copy p {{ margin:6px 0; max-width:80ch; }}
.li {{ padding-left:14px; position:relative; }}
.li::before {{ content:""; position:absolute; left:0; top:.7em; width:5px; height:5px; border-radius:50%; background:var(--clay); }}
table {{ border-collapse:collapse; margin:8px 0; font-size:13.5px; }}
td, th {{ border:1px solid var(--line); padding:6px 10px; vertical-align:top; text-align:left; }}
th {{ color:var(--muted); font-weight:600; }}
code {{ font-size:12.5px; background:#00000040; padding:1px 5px; border-radius:4px; }}
a {{ color:#f0a487; }}
</style>
</head>
<body>
<main>
<h1>Switchboard for Claude: Chrome Web Store</h1>
<p class="sub">Store assets and listing copy, generated from the real UI with dummy data. Assets: <code>docs/store/</code>. Copy: <code>docs/store-listing.md</code>. Package: <code>npm run zip</code>.</p>
<h3>Screenshots</h3>
{gallery}
<h3>Promo tiles and icon</h3>
<div class="row">
<figure><img src="promo-marquee-1400x560.jpg" alt="Marquee promo tile" width="700"><figcaption>Marquee · 1400×560</figcaption></figure>
<figure><img src="promo-small-440x280.jpg" alt="Small promo tile" width="440"><figcaption>Small promo tile · 440×280</figcaption></figure>
<figure><div class="icon"><img src="store-icon-128.png" alt="Store icon" width="128" height="128"></div><figcaption>Store icon · 128×128 (transparent padding)</figcaption></figure>
</div>
<h3>Listing copy</h3>
<div class="copy">{listing_html(open(LISTING).read())}</div>
</main>
</body>
</html>
'''

with open(OUT, 'w') as f:
    f.write(page)
print(OUT)
