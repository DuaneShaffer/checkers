import { parseArgs } from 'node:util';
import { divide, perft } from '../src/engine/perft.ts';
import { INITIAL_FEN, fromFen } from '../src/engine/position.ts';

const { values } = parseArgs({
  options: {
    depth: { type: 'string', short: 'd', default: '8' },
    fen: { type: 'string', default: INITIAL_FEN },
    divide: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log('Usage: npm run perft -- [--depth N] [--fen "B:W21,...:B1,..."] [--divide]');
  process.exit(0);
}

const depth = Number(values.depth);
const position = fromFen(values.fen);
const started = performance.now();
let total: number;

if (values.divide) {
  total = 0;
  for (const { move, nodes } of divide(position, depth)) {
    console.log(`${move.padEnd(14)} ${nodes}`);
    total += nodes;
  }
} else {
  total = perft(position, depth);
}

const seconds = (performance.now() - started) / 1000;
const nps = seconds > 0 ? Math.round(total / seconds) : total;
console.log(`perft(${depth}) = ${total}  ${seconds.toFixed(2)} s  ${nps.toLocaleString('en-US')} leaves/s`);
