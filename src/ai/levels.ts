export interface LevelSpec {
  maxDepth: number;
  timeMs: number;
  temperature: number;
  blunderRate: number;
  margin?: number;
  threatExtension: boolean;
}

export type LevelId = 1 | 2 | 3 | 4 | 5;

export const LEVELS: Record<LevelId, LevelSpec & { name: string }> = {
  1: { name: 'Novice', maxDepth: 2, timeMs: 150, temperature: 0.05, margin: 60, blunderRate: 0.15, threatExtension: false },
  2: { name: 'Casual', maxDepth: 3, timeMs: 250, temperature: 0.02, margin: 15, blunderRate: 0, threatExtension: false },
  3: { name: 'Club', maxDepth: 6, timeMs: 500, temperature: 0.005, margin: 15, blunderRate: 0, threatExtension: false },
  4: { name: 'Expert', maxDepth: 14, timeMs: 1200, temperature: 0, blunderRate: 0, threatExtension: true },
  5: { name: 'Master', maxDepth: 40, timeMs: 3000, temperature: 0, blunderRate: 0, threatExtension: true },
};
