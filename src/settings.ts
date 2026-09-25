import { isDemo } from './demo';

export const settingKeys = {
  appearance: isDemo ? 'meteroak.demo.appearance.v1' : 'meteroak.appearance.v1',
  budgets: isDemo ? 'meteroak.demo.budgets.v1' : 'meteroak.local.budgets.v1',
};
