from pathlib import Path
import pytest
from src.utils.pack_ldraw_model import LDrawPacker


def test_nova_hierarchy_and_forward_references_keep_root_and_dependencies(tmp_path):
    library = tmp_path / 'library'
    (library / 'parts').mkdir(parents=True)
    (library / 'LDConfig.ldr').write_text('0 LDraw colors\n')
    (library / 'parts/3001.dat').write_text('0 Brick\n3 16 0 0 0 20 0 0 0 8 0\n')
    source = tmp_path / 'model.mpd'
    source.write_text('0 FILE main.ldr\n0 Tower\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 Roof.ldr\n0 STEP\n'
                      '0 FILE roof.ldr\n0 Author: Example\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n')
    packed = Path(LDrawPacker(str(library)).pack_ldraw_model(str(source))).read_text()
    assert packed.startswith('0 FILE main.ldr\n0 LDraw colors\n')
    assert packed.index('0 FILE main.ldr') < packed.index('0 FILE roof.ldr') < packed.index('0 FILE parts/3001.dat')
    assert '0 STEP\n' in packed and '0 Author: Example\n' in packed
    assert '0 FILE 0 FILE' not in packed


@pytest.mark.parametrize('reference', ['/etc/passwd', '../secret.dat', '../../secret.dat'])
def test_imported_dependencies_cannot_read_host_files(tmp_path, reference):
    with pytest.raises(ValueError, match='inside the parts library'):
        LDrawPacker(str(tmp_path)).parse_object(reference)
