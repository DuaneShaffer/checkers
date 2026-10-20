import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const PURE_AI = ['features', 'network', 'heuristic', 'search', 'levels'].map((name) => `src/ai/${name}.ts`);
const NODE_BUILTINS = ['fs', 'path', 'os', 'url', 'util', 'crypto', 'worker_threads', 'child_process', 'process', 'events', 'stream', 'buffer'];

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function pureFiles(): string[] {
  const ai = PURE_AI.map((file) => join(ROOT, file)).filter(existsSync);
  return [...tsFilesUnder(join(ROOT, 'src/engine')), ...ai];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function stripStrings(source: string): string {
  return source.replace(/`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"/g, '""');
}

function moduleSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;
  for (const match of code.matchAll(pattern)) specifiers.push(match[2]);
  return specifiers;
}

function purityViolations(source: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  for (const spec of moduleSpecifiers(code)) {
    if (spec.startsWith('node:') || NODE_BUILTINS.includes(spec.split('/')[0])) violations.push(`imports ${spec}`);
    if (spec === 'three' || spec.startsWith('three/')) violations.push(`imports ${spec}`);
    if (spec === 'peerjs') violations.push(`imports ${spec}`);
  }
  if (/\brequire\s*\(/.test(code)) violations.push('uses require()');
  const bare = stripStrings(code);
  for (const global of ['document', 'window']) {
    if (new RegExp(`(?<![.\\w$])${global}(?![\\w$])`).test(bare)) violations.push(`references ${global}`);
  }
  return violations;
}

describe('purity of shared engine and AI code', () => {
  it('finds the engine sources', () => {
    expect(pureFiles().length).toBeGreaterThanOrEqual(3);
  });

  for (const file of pureFiles()) {
    it(`${relative(ROOT, file)} has no DOM, Node or three.js dependencies`, () => {
      expect(purityViolations(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }

  it('detects violations', () => {
    expect(purityViolations(`import { readFileSync } from 'node:fs';`)).toEqual(['imports node:fs']);
    expect(purityViolations(`import * as THREE from 'three';`)).toEqual(['imports three']);
    expect(purityViolations(`const m = await import('three/addons/x.js');`)).toEqual(['imports three/addons/x.js']);
    expect(purityViolations(`import { Worker } from 'worker_threads';`)).toEqual(['imports worker_threads']);
    expect(purityViolations(`const w = window.innerWidth;`)).toEqual(['references window']);
    expect(purityViolations(`document.body.append(x);`)).toEqual(['references document']);
    expect(purityViolations(`if (typeof window !== 'undefined') go();`)).toEqual(['references window']);
  });

  it('ignores comments, strings and property names', () => {
    expect(purityViolations(`// the aspiration window narrows\nconst x = 1;`)).toEqual([]);
    expect(purityViolations(`/* document order */ const y = 'window';`)).toEqual([]);
    expect(purityViolations(`const z = opts.window + state.document;`)).toEqual([]);
    expect(purityViolations(`import { Rng } from './rng.ts';`)).toEqual([]);
  });
});
