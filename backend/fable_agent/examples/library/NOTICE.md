# Notice: example build scripts

Every `.py` file in this folder is an adaptation of a public LEGO model file, converted to a
BrickBuilder build script by `fable_agent/examples/importer.py`. `SOURCES.md` lists each one with
the file it comes from, that file's author and that file's licence, and each script repeats them
in its first lines (`#: source:`, `#: author:`, `#: licence:`, `#: changes:`).

## Where the material comes from

1. **Official-set models** from the *LDraw Official Model Repository* (https://library.ldraw.org/omr):
   fan-made model files of official LEGO sets. Each file names its author (`0 Author:`) and its own
   licence (`0 !LICENSE`): "Redistributable under CCAL version 2.0" or "Licensed under CC BY 4.0".
   Only files and sections whose licence allows commercial reuse with credit are used; anything
   marked "Free for non-commercial use" is left out, along with every model that draws on it.
2. **Descriptions** of those models and of their submodels (the `#: title:` of each script, and
   `index.jsonl`): written by Carlos Antelo for the annotated copies in **ldraw-nova**
   (https://github.com/anteloc/ldraw-nova), licensed CC BY-SA 4.0.
3. **Example atlases** of ldraw-nova (`examples/` there: buildings, vehicles, spaceships, mechanisms
   and others): models by Carlos Antelo, licensed CC BY-SA 4.0.

All three were taken from the fork https://github.com/jjohnson5253/ldraw-nova at commit
`d98e9fe6b82ea725322db0dbc74519159f204f5e` (`data/models-annotated/`, `data/ldraw-info.db`,
`examples/`).

## Changes

Yes, every file was changed. Each model, and each described submodel on its own, was flattened to
its parts and rewritten as a build script of `place` calls in building order. The parts and colors
are the ones the set uses. Minifigures, parts that overlap another part and parts that nothing joins
to the rest were left out, and the model was moved to stand on the ground; `#: changes:` in each
script says how many parts were kept. A model that could not be converted, or that did not pass
BrickBuilder's checks afterwards, is not here.

## Licence of this folder

The scripts, `index.jsonl` and `SOURCES.md` are licensed Creative Commons Attribution-ShareAlike 4.0
International (CC BY-SA 4.0), https://creativecommons.org/licenses/by-sa/4.0/. The full text is in
`LICENSE-CC-BY-SA-4.0.md`. Credit the model file's author, the LDraw Official Model Repository, and
Carlos Antelo (ldraw-nova) for the descriptions and atlas models, as each script does. Nothing in
this repository restricts reusing this folder under that licence.

LEGO is a trademark of the LEGO Group, which does not sponsor, authorize or endorse BrickBuilder.
