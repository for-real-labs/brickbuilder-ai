"""Read Studio archives and normalize uploaded geometry to Nova-ready MPD.

No files are extracted or executed. Nova retains ownership of model editing,
physical-part classification, and catalog validation when publishing an edit.
"""
import io
import math
import re
import zipfile
from pathlib import PurePosixPath

MAX_UPLOAD_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 2000
MAX_PLACEMENTS = 100_000
STUDIO_PASSWORD = b'soho0909'  # Public Studio container-format password, not a user credential.


def _safe_name(name: str) -> str:
    name = name.replace('\\', '/')
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '..' in path.parts or ':' in name or any(ord(c) < 32 for c in name):
        raise ValueError('The model contains an unsafe file reference.')
    return name


def _decode(data: bytes) -> str:
    try:
        return data.decode('utf-8-sig')
    except UnicodeDecodeError:
        return data.decode('cp1252')


def normalize_ldraw_upload(filename: str, data: bytes) -> str:
    extension = PurePosixPath(filename.replace('\\', '/')).suffix.lower()
    if extension not in {'.io', '.ldr', '.mpd'}:
        raise ValueError('Choose a Studio .io, LDraw .ldr, or .mpd file.')
    if not data:
        raise ValueError('The uploaded file is empty.')
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError('Choose a model smaller than 16 MB.')
    additions = []
    if extension == '.io':
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                names = set()
                total = 0
                for entry in entries:
                    name = _safe_name(entry.filename).lower()
                    total += entry.file_size
                    if name in names or len(entries) > MAX_ARCHIVE_ENTRIES or total > MAX_UPLOAD_BYTES:
                        raise ValueError('This Studio archive is too large or contains duplicate files.')
                    names.add(name)
                model = next((entry for entry in entries if entry.filename.lower() == 'model.ldr'), None)
                if model is None:
                    raise ValueError('This Studio file does not contain model.ldr.')
                data = archive.read(model, pwd=STUDIO_PASSWORD)
                for entry in entries:
                    if entry is model or entry.is_dir():
                        continue
                    if PurePosixPath(entry.filename).suffix.lower() in {'.dat', '.ldr', '.mpd'}:
                        additions.append((_safe_name(entry.filename), _decode(archive.read(entry, pwd=STUDIO_PASSWORD))))
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, UnicodeError, OSError) as exc:
            raise ValueError('Unable to read this Studio file. Try exporting it as LDraw (.ldr or .mpd).') from exc
    text = _decode(data).replace('\r\n', '\n').replace('\r', '\n').strip()
    if '\x00' in text:
        raise ValueError('This file is not a text LDraw model.')
    if not re.search(r'^0\s+FILE\s+', text, re.MULTILINE | re.IGNORECASE):
        text = '0 FILE model.ldr\n' + text
    embedded = {match.lower() for match in re.findall(r'^0\s+FILE\s+(.+)$', text, re.MULTILINE | re.IGNORECASE)}
    for name, content in additions:
        if name.lower() not in embedded:
            text += '\n0 FILE ' + name + '\n' + content.strip()
    sections = {}
    current = None
    placements = 0
    for line in text.splitlines():
        if len(line) > 65536:
            raise ValueError('The model contains an oversized line.')
        tokens = line.split()
        if not tokens:
            continue
        if tokens[0] not in {'0', '1', '2', '3', '4', '5'}:
            raise ValueError('This file is not a valid LDraw model.')
        if len(tokens) >= 3 and tokens[0] == '0' and tokens[1].upper() == 'FILE':
            current = _safe_name(line.split(None, 2)[2]).lower()
            if current in sections:
                raise ValueError('The model contains duplicate submodel names.')
            sections[current] = []
        if tokens[0] == '1':
            fields = line.split(None, 14)
            if len(fields) != 15:
                raise ValueError('The model contains an invalid part placement.')
            try:
                int(fields[1], 0) if fields[1].lower().startswith('0x') else int(fields[1])
                if not all(math.isfinite(float(value)) for value in fields[2:14]):
                    raise ValueError()
            except ValueError:
                raise ValueError('The model contains an invalid placement transform.') from None
            reference = _safe_name(fields[14]).lower()
            if current is None:
                raise ValueError('The model contains geometry outside its MPD sections.')
            sections[current].append(reference)
            placements += 1
            if placements > MAX_PLACEMENTS:
                raise ValueError('This model contains too many placements.')
    if not placements:
        raise ValueError('This model contains no parts.')
    # Reject recursive/overdeep submodels before the viewer or Nova sees them.
    visited = set()
    def visit(name, active):
        if name in active or len(active) >= 64:
            raise ValueError('The model contains recursive or overly nested submodels.')
        if name in visited:
            return
        for reference in sections.get(name, []):
            if reference in sections:
                visit(reference, active | {name})
            elif reference.endswith(('.ldr', '.mpd')):
                raise ValueError('The model references a missing submodel. Export a self-contained MPD first.')
        visited.add(name)
    for name in sections:
        visit(name, set())
    if len(text.encode('utf-8')) > MAX_UPLOAD_BYTES:
        raise ValueError('The converted model exceeds 16 MB.')
    return text + '\n'
