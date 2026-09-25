import type { RawDashboardSnapshot } from './types';

export const isDemo = import.meta.env.MODE === 'demo';

export async function loadDemoDashboard(): Promise<RawDashboardSnapshot> {
  if (import.meta.env.MODE === 'demo') {
    const { default: snapshot } = await import('../test/fixtures/dashboard.json?raw');
    return JSON.parse(snapshot) as RawDashboardSnapshot;
  }
  throw new Error('Sample data is available only in the demo build.');
}
