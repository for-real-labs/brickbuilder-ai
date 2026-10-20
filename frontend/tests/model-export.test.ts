import { afterEach, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createModelExport, downloadModel, modelParts } from '../src/utils/modelExport';

const placement = (file: string, color = 4) => `1 ${color} 0 0 0 1 0 0 0 1 0 0 0 1 ${file}`;
const model = ['0 FILE main.ldr', placement('wing.ldr'), placement('wing.ldr'), placement('3002.dat', 71),
  '0 FILE wing.ldr', placement('3001.dat', 16), '0 FILE 3001.dat', placement('stud.dat'), '0 FILE stud.dat', '3 16 0 0 0 1 0 0 0 1 0'].join('\n');
const read = (blob: Blob): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob);
});
const text = async (blob: Blob) => strFromU8(new Uint8Array(await read(blob)));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('counts repeated submodels with inherited colors, without counting brick geometry', () => {
  expect(modelParts(model)).toEqual([{ id: '3001', color: 4, quantity: 2 }, { id: '3002', color: 71, quantity: 1 }]);
});

it('counts packed model placements before library FILE sections and accepts parts paths', async () => {
  const packed = [
    '0 LDraw.org Configuration File',
    placement('parts/3020.dat', 40),
    placement('parts/3020.dat', 40),
    placement('parts/3062b.dat', 47),
    '0 FILE parts/3020.dat', placement('p/stud.dat', 16),
    '0 FILE p/stud.dat', '3 16 0 0 0 1 0 0 0 1 0',
  ].join('\n');
  expect(modelParts(packed)).toEqual([
    { id: '3020', color: 40, quantity: 2 },
    { id: '3062b', color: 47, quantity: 1 },
  ]);
  expect(await text(createModelExport(packed, 'BVG Tram', 'csv').blob))
    .toBe('LdrawId,LDrawColorId,Qty\r\n3020.dat,40,2\r\n3062b.dat,47,1\r\n');
  const xml = await text(createModelExport(packed, 'BVG Tram', 'xml').blob);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect([...doc.querySelectorAll('COLOR')].map(node => node.textContent)).toEqual(['13', '12']);
});

it('exports complete LDraw and a Studio archive containing the same model', async () => {
  const ldraw = createModelExport(model, '../Castle / model', 'ldraw');
  expect(ldraw.filename).toBe('Castle_model.ldr');
  expect(await text(ldraw.blob)).toBe(model);
  const io = createModelExport(model, 'Castle', 'io');
  expect(io.filename).toBe('Castle.io');
  const archive = unzipSync(new Uint8Array(await read(io.blob)));
  expect(strFromU8(archive['model.ldr'])).toBe(model);
});

it('exports CSV quantities and BrickLink XML with translated color IDs', async () => {
  expect(await text(createModelExport(model, 'Castle', 'csv').blob)).toBe('LdrawId,LDrawColorId,Qty\r\n3001.dat,4,2\r\n3002.dat,71,1\r\n');
  const xml = await text(createModelExport(model, 'Castle', 'xml').blob);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect([...doc.querySelectorAll('COLOR')].map(node => node.textContent)).toEqual(['5', '86']);
  expect([...doc.querySelectorAll('MINQTY')].map(node => node.textContent)).toEqual(['2', '1']);
});

it('rejects cyclic models, unsafe part IDs and unmapped XML colors without corrupt downloads', () => {
  expect(() => modelParts(`0 FILE loop.ldr\n${placement('loop.ldr')}`)).toThrow('circular');
  expect(() => modelParts(placement('<bad>.dat'))).toThrow('cannot be exported');
  expect(() => modelParts(placement('parts/s/stud.dat'))).toThrow('cannot be exported');
  expect(() => createModelExport(placement('3001.dat', 99999), 'model', 'xml')).toThrow('no BrickLink match');
  expect(() => modelParts('0 Empty')).toThrow('No parts');
});

it('downloads the named file and releases its temporary URL', () => {
  vi.useFakeTimers();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:model') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  let filename = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { filename = this.download; });
  downloadModel(model, 'Castle', 'io');
  expect(filename).toBe('Castle.io');
  expect(document.querySelector('a[download]')).toBeNull();
  vi.runAllTimers();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:model');
});
