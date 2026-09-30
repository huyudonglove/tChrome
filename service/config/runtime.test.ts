import { expect, test } from 'bun:test';
import { deriveGates, type GateSpec } from './runtime.ts';

const BASE = 200_000;

test('derives gates from the base using the declared ratios', () => {
  const gates: Record<string, GateSpec> = {
    compressAtChars: { follow: 'contextWindowChars', ratio: 1 },
    externalizeAtChars: { follow: 'contextWindowChars', ratio: 1.25 },
    inlineChars: { follow: 'contextWindowChars', ratio: 0.02, cap: 4000 },
    previewChars: { follow: 'inlineChars', ratio: 0.1, floor: 200 },
  };
  expect(deriveGates(BASE, gates)).toEqual({
    compressAtChars: 200000,
    externalizeAtChars: 250000,
    inlineChars: 4000,
    previewChars: 400,
  });
});

test('cap pins a gate when the base grows', () => {
  const gates: Record<string, GateSpec> = { inlineChars: { follow: 'contextWindowChars', ratio: 0.02, cap: 4000 } };
  expect(deriveGates(250_000, gates).inlineChars).toBe(4000);
  expect(deriveGates(100_000, gates).inlineChars).toBe(2000);
});

test('floor keeps a gate from collapsing on a small base', () => {
  const gates: Record<string, GateSpec> = {
    inlineChars: { follow: 'contextWindowChars', ratio: 0.02, cap: 4000 },
    previewChars: { follow: 'inlineChars', ratio: 0.1, floor: 200 },
  };
  const values = deriveGates(1000, gates);
  expect(values.inlineChars).toBe(20);
  expect(values.previewChars).toBe(200);
});

test('fixed gates ignore the base', () => {
  const gates: Record<string, GateSpec> = { imageInlineBytes: { fixed: 262144 } };
  expect(deriveGates(1000, gates).imageInlineBytes).toBe(262144);
  expect(deriveGates(999_999, gates).imageInlineBytes).toBe(262144);
});

test('an unknown follow target fails fast', () => {
  const gates: Record<string, GateSpec> = { previewChars: { follow: 'nope', ratio: 0.1 } };
  expect(() => deriveGates(BASE, gates)).toThrow(/gates\.nope is not declared/);
});

test('a follow cycle fails fast instead of recursing', () => {
  const gates: Record<string, GateSpec> = {
    a: { follow: 'b', ratio: 1 },
    b: { follow: 'a', ratio: 1 },
  };
  expect(() => deriveGates(BASE, gates)).toThrow(/follows itself/);
});

test('a non-positive base is rejected', () => {
  expect(() => deriveGates(0, {})).toThrow(/scale\.contextWindowChars/);
});

test('a ratio that rounds to zero is rejected', () => {
  const gates: Record<string, GateSpec> = { tiny: { follow: 'contextWindowChars', ratio: 0.0001 } };
  expect(() => deriveGates(1000, gates)).toThrow(/gates\.tiny/);
});
