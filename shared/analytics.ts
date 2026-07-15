export const ANALYTICS_GAMES = ['racer', 'monsters', 'fighter'] as const;
export type AnalyticsGame = typeof ANALYTICS_GAMES[number];

export interface AnalyticsGameMetrics {
  participants: number;
  sessions: number;
  completed: number;
  abandoned: number;
  playSeconds: number;
  voiceCommands: number;
  completionRate: number;
  averageSessionSeconds: number;
}

export interface AnalyticsTrendPoint {
  date: string;
  participants: number;
  sessions: number;
  completed: number;
  playSeconds: number;
  voiceCommands: number;
}

export interface AnalyticsReport {
  generatedAt: string;
  range: { from: string; to: string; days: number };
  filter: AnalyticsGame | 'all';
  summary: AnalyticsGameMetrics;
  games: Record<AnalyticsGame, AnalyticsGameMetrics>;
  trend: AnalyticsTrendPoint[];
  selections: {
    maps: { name: string; count: number }[];
    characters: { name: string; count: number }[];
    vehicles: { name: string; count: number }[];
  };
  insights: string[];
}
