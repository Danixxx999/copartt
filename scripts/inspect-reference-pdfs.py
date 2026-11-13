from pathlib import Path
from pypdf import PdfReader
import pypdfium2 as pdfium
from PIL import Image, ImageOps, ImageDraw

root = Path(__file__).resolve().parents[1]
out = root / 'docs' / 'reference-pdfs'
out.mkdir(parents=True, exist_ok=True)
base = Path('C:/Users/usuario/Downloads')
names = [
    'Subastas de autos 100 % en línea - Copart USA - Venta de autos usados __en subastas de autos en línea.pdf',
    'Subastas de autos 100 % en línea - Copart USA - Venta de autos usados __en subastas de autos en línea (1).pdf',
]
for number, name in enumerate(names, 1):
    source = base / name
    reader = PdfReader(source)
    doc = pdfium.PdfDocument(str(source))
    text = []
    thumbs = []
    print(f'PDF {number}: {len(reader.pages)} pages')
    for i, page in enumerate(reader.pages):
        page_text = page.extract_text() or ''
        text.append(f'\n--- PAGE {i+1} ---\n{page_text}')
        print(f'  page {i+1}: {tuple(page.mediabox)}; {len(page_text)} chars; images {len(page.images)}')
        image = doc[i].render(scale=1).to_pil().convert('RGB')
        image.save(out / f'pdf-{number}-page-{i+1}.jpg', quality=90)
        image.thumbnail((330, 500))
        thumb = Image.new('RGB', (350, 530), 'white')
        thumb.paste(image, (10, 25))
        ImageDraw.Draw(thumb).text((10, 5), f'PDF {number} / page {i+1}', fill='black')
        thumbs.append(thumb)
    (out / f'pdf-{number}-text.txt').write_text(''.join(text), encoding='utf8')
    cols = min(4, len(thumbs))
    rows = (len(thumbs)+cols-1)//cols
    sheet = Image.new('RGB', (cols*350, rows*530), '#aaa')
    for i, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((i%cols)*350, (i//cols)*530))
    sheet.save(out / f'pdf-{number}-overview.jpg', quality=90)
    doc.close()
