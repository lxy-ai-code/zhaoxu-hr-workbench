import json
import pathlib
import sys

sys.stdout.reconfigure(encoding='utf-8')
file = pathlib.Path(sys.argv[1])
kind = sys.argv[2]
try:
    if kind == 'pdf':
        text = ''
        try:
            from pypdf import PdfReader
            reader = PdfReader(file)
            if len(reader.pages) > 200:
                raise ValueError('too_many_pages')
            text = '\n\n'.join(page.extract_text() or '' for page in reader.pages)
        except Exception:
            pass
        if not text.strip():
            import pdfplumber
            with pdfplumber.open(file) as document:
                if len(document.pages) > 200:
                    raise ValueError('too_many_pages')
                text = '\n\n'.join(page.extract_text() or '' for page in document.pages)
    elif kind == 'docx':
        import zipfile
        with zipfile.ZipFile(file) as archive:
            entries = archive.infolist()
            if len(entries) > 5000 or sum(entry.file_size for entry in entries) > 80 * 1024 * 1024:
                raise ValueError('archive_expansion_limit')
            if any('vbaProject' in entry.filename for entry in entries):
                raise ValueError('unsupported_macro_content')
        from docx import Document
        document = Document(file)
        parts = [paragraph.text for paragraph in document.paragraphs]
        for table in document.tables:
            parts.extend(' | '.join(cell.text for cell in row.cells) for row in table.rows)
        text = '\n'.join(parts)
    else:
        data = file.read_bytes()
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = data.decode('gb18030')
    print(json.dumps({'ok': True, 'text': text[:200000], 'truncated': len(text) > 200000, 'textStatus': 'parsed' if text.strip() else 'needs_ocr'}, ensure_ascii=False))
except Exception:
    print(json.dumps({'ok': False, 'text': '', 'textStatus': 'parse_failed'}, ensure_ascii=False))
