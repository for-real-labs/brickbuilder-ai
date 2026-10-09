import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { adjustModelCamera } from '../src/utils/adjustModelCamera';

it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])('rotates with %s while preserving zoom and the model’s center', key => {
  const camera = new THREE.PerspectiveCamera(); camera.position.set(90, 70, 110);
  const controls = { target: new THREE.Vector3(10, 20, 30), minDistance: 5, maxDistance: 200, update: vi.fn() };
  const distance = camera.position.distanceTo(controls.target), original = camera.position.clone();
  expect(adjustModelCamera(camera, controls, key)).toBe(true);
  expect(camera.position.equals(original)).toBe(false);
  expect(camera.position.distanceTo(controls.target)).toBeCloseTo(distance);
  expect(controls.target).toEqual(new THREE.Vector3(10, 20, 30));
  expect(controls.update).toHaveBeenCalledOnce();
});

it('zooms without changing direction and respects the camera distance limits', () => {
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 0, 10);
  const controls = { target: new THREE.Vector3(), minDistance: 8, maxDistance: 12, update: vi.fn() };
  for (let i = 0; i < 20; i++) adjustModelCamera(camera, controls, '+');
  expect(camera.position.z).toBeCloseTo(8);
  for (let i = 0; i < 20; i++) adjustModelCamera(camera, controls, '-');
  expect(camera.position.z).toBeCloseTo(12);
  expect(camera.position.x).toBeCloseTo(0);
  expect(camera.position.y).toBeCloseTo(0);
});

it('leaves Tab and Escape for normal focus navigation and dialog closing', () => {
  const camera = new THREE.PerspectiveCamera(); camera.position.set(5, 10, 20);
  const controls = { target: new THREE.Vector3(), minDistance: 1, maxDistance: 100, update: vi.fn() };
  expect(adjustModelCamera(camera, controls, 'Tab')).toBe(false);
  expect(adjustModelCamera(camera, controls, 'Escape')).toBe(false);
  expect(camera.position).toEqual(new THREE.Vector3(5, 10, 20));
  expect(controls.update).not.toHaveBeenCalled();
});
