"""Bundle the browser tool into one offline-capable HTML file (no dependencies)."""
from pathlib import Path

root = Path(__file__).resolve().parent
page = (root / 'index.template.html').read_text()
for marker, file, attributes in [
    ('WORKER_SOURCE', 'modem-worker.js', 'id="worker-source" type="text/plain"'),
    ('VISUAL_CODEC_SOURCE', 'visual-codec.js', ''),
    ('APP_SOURCE', 'app.js', ''),
    ('VISUAL_APP_SOURCE', 'visual-app.js', ''),
]:
    source = (root / file).read_text().replace('</script', '<\\/script')
    page = page.replace(f'<!-- {marker} -->', f'<script {attributes}>\n{source}\n</script>')
(root / 'index.html').write_text(page)
print(root / 'index.html')
